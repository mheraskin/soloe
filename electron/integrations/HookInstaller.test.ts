import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import {
  HookInstaller,
  defaultLocalHost,
  mergeClaudeHooks,
  removeSoloeFromClaude,
  mergeCodexHooks,
  removeSoloeFromCodex,
  mergeClaudeMcp,
  mergeCodexMcp,
  mergeCursorMcp,
  mergeCursorHooks,
  removeSoloeFromCursor,
  removeSoloeFromCursorHooks,
  mcpUrlForHost,
  SOLOE_HOOK_VERSION,
  type HookHost
} from './HookInstaller.js';

function localHost(homeDir: string): HookHost {
  return { kind: 'windows', label: 'Test Local', homeDir, available: true };
}

function wslHost(distro: string, homeDir: string): HookHost {
  return { kind: 'wsl', distro, label: `WSL: ${distro}`, homeDir, available: true };
}

const LOCAL: { kind: 'windows' } = { kind: 'windows' };

describe('HookInstaller', () => {
  let homeDir: string;
  let installer: HookInstaller;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'soloe-home-'));
    installer = new HookInstaller({ hosts: [localHost(homeDir)] });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('exposes a native macOS integration host for darwin', () => {
    expect(defaultLocalHost('darwin')).toMatchObject({
      kind: 'macos',
      label: 'macOS',
      available: true
    });
  });

  it('does not expose backend home paths in public status', async () => {
    const status = await installer.status();

    expect(status.hosts).toEqual([
      {
        host: {
          kind: 'windows',
          label: 'Test Local',
          available: true
        },
        claude: { installed: false, current: false },
        codex: { installed: false, current: false },
        cursor: { installed: false, current: false }
      }
    ]);
    expect(JSON.stringify(status)).not.toContain(homeDir);
  });

  describe('claude install/uninstall', () => {
    it('writes hooks for all supported events on first install', async () => {
      await installer.installClaude(LOCAL);
      const written = JSON.parse(
        await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8')
      );
      expect(Object.keys(written.hooks)).toEqual(
        expect.arrayContaining([
          'SessionStart',
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'Notification',
          'Stop',
          'StopFailure',
          'SessionEnd',
          'PreCompact',
          'SubagentStop'
        ])
      );
    });

    it('writes a hook command that actually runs curl when SOLOE_BRIDGE_URL is set', async () => {
      await installer.installClaude(LOCAL);
      const written = JSON.parse(
        await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8')
      );
      const cmd = written.hooks.SessionStart[0].hooks[0].command as string;
      // Must use semicolons (not bare space) to separate steps; otherwise bash parses
      // `[ ... ] && exit 0 curl ...` as a single command and curl never runs.
      expect(cmd).toMatch(/^\[ -z "\$SOLOE_BRIDGE_URL" \] && \{ cat >\/dev\/null 2>&1; exit 0; \};\s/);
      expect(cmd).toMatch(/;\s*curl /);
      expect(cmd).toContain('--connect-timeout 0.1 --max-time 1');
      expect(cmd).toContain('"$u/hook/claude"');
      // WSL host resolution: substitute host.wsl.internal when it doesn't resolve
      expect(cmd).toContain('host.wsl.internal');
      expect(cmd).toContain('getent hosts host.wsl.internal');
    });

    it('preserves user keys when merging', async () => {
      const path = join(homeDir, '.claude', 'settings.json');
      await fs.mkdir(join(homeDir, '.claude'), { recursive: true });
      await fs.writeFile(
        path,
        JSON.stringify({
          env: { FOO: 'bar' },
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: 'user-script' }] }
            ]
          }
        })
      );
      await installer.installClaude(LOCAL);
      const written = JSON.parse(await fs.readFile(path, 'utf8'));
      expect(written.env).toEqual({ FOO: 'bar' });
      const groups = written.hooks.UserPromptSubmit;
      expect(groups).toHaveLength(2);
      expect(groups[0].hooks[0].command).toBe('user-script');
      expect(groups[1]._soloe).toBe(true);
      expect(groups[1]._soloe_version).toBe(SOLOE_HOOK_VERSION);
      expect(groups[1].hooks[0]._soloe_version).toBe(SOLOE_HOOK_VERSION);
    });

    it('install→uninstall is a no-op when no prior config existed', async () => {
      const path = join(homeDir, '.claude', 'settings.json');
      await installer.installClaude(LOCAL);
      await installer.uninstallClaude(LOCAL);
      const written = JSON.parse(await fs.readFile(path, 'utf8'));
      expect(written).toEqual({});
    });

    it('uninstall preserves unrelated user keys and entries', async () => {
      const path = join(homeDir, '.claude', 'settings.json');
      await fs.mkdir(join(homeDir, '.claude'), { recursive: true });
      await fs.writeFile(
        path,
        JSON.stringify({
          env: { FOO: 'bar' },
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: 'user-script' }] }
            ]
          }
        })
      );
      await installer.installClaude(LOCAL);
      await installer.uninstallClaude(LOCAL);
      const written = JSON.parse(await fs.readFile(path, 'utf8'));
      expect(written.env).toEqual({ FOO: 'bar' });
      expect(written.hooks.UserPromptSubmit).toEqual([
        { hooks: [{ type: 'command', command: 'user-script' }] }
      ]);
    });

    it('creates a backup file when overwriting an existing settings.json', async () => {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      await fs.mkdir(join(homeDir, '.claude'), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify({ existing: true }));
      await installer.installClaude(LOCAL);
      const entries = await fs.readdir(join(homeDir, '.claude'));
      expect(entries.some((e) => e.includes('soloe-backup'))).toBe(true);
    });

    it('reinstalling does not stack duplicate entries', async () => {
      await installer.installClaude(LOCAL);
      await installer.installClaude(LOCAL);
      const written = JSON.parse(
        await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8')
      );
      expect(written.hooks.UserPromptSubmit).toHaveLength(1);
    });

    it('routes user scope to the requested host', async () => {
      const wslHomeDir = mkdtempSync(join(tmpdir(), 'soloe-wsl-'));
      try {
        const multi = new HookInstaller({
          hosts: [localHost(homeDir), wslHost('Ubuntu', wslHomeDir)]
        });
        await multi.installClaude({ kind: 'wsl', distro: 'Ubuntu' });
        const wslWritten = JSON.parse(
          await fs.readFile(join(wslHomeDir, '.claude', 'settings.json'), 'utf8')
        );
        expect(wslWritten.hooks.SessionStart).toHaveLength(1);
        // Local host file should not be created
        const localExists = await fs
          .stat(join(homeDir, '.claude', 'settings.json'))
          .then(() => true)
          .catch(() => false);
        expect(localExists).toBe(false);
      } finally {
        rmSync(wslHomeDir, { recursive: true, force: true });
      }
    });

    it('throws when targeting an unknown host', async () => {
      await expect(
        installer.installClaude({ kind: 'wsl', distro: 'Nonexistent' })
      ).rejects.toThrow(/Unknown host/);
    });

    it('throws when targeting an unavailable host', async () => {
      const unavailable = new HookInstaller({
        hosts: [
          {
            kind: 'wsl',
            distro: 'Broken',
            label: 'WSL: Broken',
            homeDir: '',
            available: false,
            reason: 'no $HOME'
          }
        ]
      });
      await expect(
        unavailable.installClaude({ kind: 'wsl', distro: 'Broken' })
      ).rejects.toThrow(/unavailable/);
    });
  });

  describe('codex install/uninstall', () => {
    it('writes hooks for all supported events on first install', async () => {
      await installer.installCodex(LOCAL);
      const raw = await fs.readFile(join(homeDir, '.codex', 'config.toml'), 'utf8');
      const parsed = parseToml(raw) as { hooks: Record<string, unknown[]> };
      expect(Object.keys(parsed.hooks)).toEqual(
        expect.arrayContaining([
          'SessionStart',
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'PermissionRequest',
          'Stop'
        ])
      );
      expect((parsed as { features?: { hooks?: boolean } }).features?.hooks).toBe(true);
    });

    it('writes a hook command that actually runs curl', async () => {
      await installer.installCodex(LOCAL);
      const raw = await fs.readFile(join(homeDir, '.codex', 'config.toml'), 'utf8');
      const parsed = parseToml(raw) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      const cmd = parsed.hooks.SessionStart![0]!.hooks[0]!.command;
      expect(cmd).toMatch(/^\[ -z "\$SOLOE_BRIDGE_URL" \] && \{ cat >\/dev\/null 2>&1; exit 0; \};\s/);
      expect(cmd).toMatch(/;\s*curl /);
      expect(cmd).toContain('--connect-timeout 0.1 --max-time 1');
      expect(cmd).toContain('"$u/hook/codex"');
      expect(cmd).toContain('host.wsl.internal');
      expect(cmd).toContain('getent hosts host.wsl.internal');
    });

    it('preserves user keys when merging', async () => {
      const path = join(homeDir, '.codex', 'config.toml');
      await fs.mkdir(join(homeDir, '.codex'), { recursive: true });
      await fs.writeFile(
        path,
        [
          'model = "gpt-5"',
          '',
          '[[hooks.UserPromptSubmit]]',
          '',
          '[[hooks.UserPromptSubmit.hooks]]',
          'type = "command"',
          'command = "user-script"'
        ].join('\n')
      );
      await installer.installCodex(LOCAL);
      const parsed = parseToml(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
      expect(parsed['model']).toBe('gpt-5');
      const ups = (parsed['hooks'] as Record<string, unknown[]>)['UserPromptSubmit']!;
      expect(ups).toHaveLength(2);
      expect((ups[0] as { hooks: Array<{ command: string }> }).hooks[0]!.command).toBe(
        'user-script'
      );
      expect((ups[1] as { _soloe_version?: number })._soloe_version).toBe(SOLOE_HOOK_VERSION);
      expect(
        (ups[1] as { hooks: Array<{ _soloe_version?: number }> }).hooks[0]!._soloe_version
      ).toBe(SOLOE_HOOK_VERSION);
    });

    it('install→uninstall removes only Soloe entries', async () => {
      const path = join(homeDir, '.codex', 'config.toml');
      await fs.mkdir(join(homeDir, '.codex'), { recursive: true });
      await fs.writeFile(
        path,
        [
          'model = "gpt-5"',
          '',
          '[[hooks.UserPromptSubmit]]',
          '',
          '[[hooks.UserPromptSubmit.hooks]]',
          'type = "command"',
          'command = "user-script"'
        ].join('\n')
      );
      await installer.installCodex(LOCAL);
      await installer.uninstallCodex(LOCAL);
      const parsed = parseToml(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
      expect(parsed['model']).toBe('gpt-5');
      const ups = (parsed['hooks'] as Record<string, unknown[]>)['UserPromptSubmit']!;
      expect(ups).toHaveLength(1);
      expect(
        (ups[0] as { hooks: Array<{ command: string }> }).hooks[0]!.command
      ).toBe('user-script');
    });

    it('reinstalling does not stack duplicate entries', async () => {
      await installer.installCodex(LOCAL);
      await installer.installCodex(LOCAL);
      const parsed = parseToml(
        await fs.readFile(join(homeDir, '.codex', 'config.toml'), 'utf8')
      ) as Record<string, Record<string, unknown[]>>;
      expect(parsed['hooks']?.['SessionStart']).toHaveLength(1);
    });

    it('replaces legacy flat Soloe hook entries on install', async () => {
      const path = join(homeDir, '.codex', 'config.toml');
      await fs.mkdir(join(homeDir, '.codex'), { recursive: true });
      await fs.writeFile(
        path,
        [
          '[[hooks.SessionStart]]',
          'type = "command"',
          'command = "old-soloe"',
          '_soloe = true',
          '_soloe_version = 3'
        ].join('\n')
      );
      await installer.installCodex(LOCAL);
      const parsed = parseToml(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
      const hooks = parsed['hooks'] as Record<string, unknown[]>;
      expect(hooks['SessionStart']).toHaveLength(1);
      const group = hooks['SessionStart']![0] as {
        _soloe_version: number;
        hooks: Array<{ command: string }>;
      };
      expect(group._soloe_version).toBe(SOLOE_HOOK_VERSION);
      expect(group.hooks[0]!.command).toContain('"$u/hook/codex"');
    });
  });

  describe('status()', () => {
    it('reports nothing when no files exist', async () => {
      const s = await installer.status();
      expect(s.hosts).toHaveLength(1);
      expect(s.hosts[0]!.host.kind).toBe('windows');
      expect(s.hosts[0]!.claude).toEqual({ installed: false, current: false });
      expect(s.hosts[0]!.codex).toEqual({ installed: false, current: false });
    });

    it('reports installed scopes after install', async () => {
      await installer.installClaude(LOCAL);
      await installer.installCodex(LOCAL);
      const s = await installer.status();
      expect(s.hosts[0]!.claude).toEqual({
        installed: true,
        current: true,
        version: SOLOE_HOOK_VERSION
      });
      expect(s.hosts[0]!.codex).toEqual({
        installed: true,
        current: true,
        version: SOLOE_HOOK_VERSION
      });
    });

    it('reports old Soloe hook entries as installed but stale', async () => {
      const claudePath = join(homeDir, '.claude', 'settings.json');
      await fs.mkdir(join(homeDir, '.claude'), { recursive: true });
      await fs.writeFile(
        claudePath,
        JSON.stringify({ hooks: { Stop: [{ _soloe: true, hooks: [] }] } })
      );
      const codexPath = join(homeDir, '.codex', 'config.toml');
      await fs.mkdir(join(homeDir, '.codex'), { recursive: true });
      await fs.writeFile(
        codexPath,
        ['[[hooks.SessionStart]]', 'type = "command"', 'command = "old"', '_soloe = true'].join(
          '\n'
        )
      );
      const s = await installer.status();
      expect(s.hosts[0]!.claude).toEqual({ installed: true, current: false, version: 1 });
      expect(s.hosts[0]!.codex).toEqual({ installed: true, current: false, version: 1 });
    });

    it('returns empty status entries for unavailable hosts', async () => {
      const multi = new HookInstaller({
        hosts: [
          localHost(homeDir),
          {
            kind: 'wsl',
            distro: 'Broken',
            label: 'WSL: Broken',
            homeDir: '',
            available: false,
            reason: 'no $HOME'
          }
        ]
      });
      const s = await multi.status();
      expect(s.hosts).toHaveLength(2);
      expect(s.hosts[1]!.host.available).toBe(false);
      expect(s.hosts[1]!.claude).toEqual({ installed: false, current: false });
      expect(s.hosts[1]!.codex).toEqual({ installed: false, current: false });
    });
  });
});

describe('mergeClaudeHooks (pure)', () => {
  it('keeps non-Soloe entries on merge', () => {
    const merged = mergeClaudeHooks(
      {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] }
      },
      'soloe'
    );
    expect((merged.hooks as Record<string, unknown[]>).Stop).toHaveLength(2);
  });

  it('replaces only the Soloe entry on re-merge', () => {
    const first = mergeClaudeHooks({}, 'old');
    const second = mergeClaudeHooks(first, 'new');
    const stop = (second.hooks as Record<string, unknown[]>).Stop as Array<{
      hooks: Array<{ command: string }>;
    }>;
    expect(stop).toHaveLength(1);
    expect(stop[0]!.hooks[0]!.command).toBe('new');
  });

  it('does not install unsupported Claude interrupt hooks', () => {
    const merged = mergeClaudeHooks({}, 'soloe');
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(hooks.Interrupt).toBeUndefined();
    expect(hooks.UserInterrupt).toBeUndefined();
  });

  it('removes old Soloe entries from unsupported Claude events on re-merge', () => {
    const merged = mergeClaudeHooks(
      {
        hooks: {
          Interrupt: [
            {
              _soloe: true,
              _soloe_version: 8,
              hooks: [{ type: 'command', command: 'old', _soloe: true, _soloe_version: 8 }]
            },
            { hooks: [{ type: 'command', command: 'mine' }] }
          ],
          UserInterrupt: [
            {
              _soloe: true,
              _soloe_version: 8,
              hooks: [{ type: 'command', command: 'old', _soloe: true, _soloe_version: 8 }]
            }
          ]
        }
      },
      'soloe'
    );
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(hooks.Interrupt).toEqual([{ hooks: [{ type: 'command', command: 'mine' }] }]);
    expect(hooks.UserInterrupt).toBeUndefined();
  });
});

describe('removeSoloeFromClaude (pure)', () => {
  it('returns input untouched when no Soloe entries exist', () => {
    const data = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } };
    expect(removeSoloeFromClaude(data)).toEqual(data);
  });

  it('drops the hooks block entirely if every event becomes empty', () => {
    const installed = mergeClaudeHooks({}, 'cmd');
    const cleaned = removeSoloeFromClaude(installed);
    expect(cleaned.hooks).toBeUndefined();
  });
});

describe('mergeCodexHooks / removeSoloeFromCodex (pure)', () => {
  const KEY_PATH = '/home/foo/.codex/config.toml';

  it('roundtrip preserves user entries', () => {
    const original = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'user' }] }]
      }
    };
    const installed = mergeCodexHooks(original, 'soloe', KEY_PATH);
    const cleaned = removeSoloeFromCodex(installed, KEY_PATH);
    expect((cleaned.hooks as Record<string, unknown[]>)['UserPromptSubmit']).toEqual(
      original.hooks.UserPromptSubmit
    );
  });

  it('writes [hooks.state] entries that pre-trust each soloe hook', () => {
    const installed = mergeCodexHooks({}, 'soloe', KEY_PATH);
    const state = (installed.hooks as Record<string, unknown>)['state'] as Record<
      string,
      { enabled: boolean; trusted_hash: string }
    >;
    const preToolUseKey = `${KEY_PATH}:pre_tool_use:0:0`;
    expect(state[preToolUseKey]).toBeDefined();
    expect(state[preToolUseKey]!.enabled).toBe(true);
    expect(state[preToolUseKey]!.trusted_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(state[`${KEY_PATH}:user_prompt_submit:0:0`]).toBeDefined();
    expect(state[`${KEY_PATH}:stop:0:0`]).toBeDefined();
  });

  it('matches codex command_hook_hash for a known input', () => {
    // Replicates codex's pipeline byte-for-byte, asserting the canonical
    // JSON we hash matches what serde_json::to_value(canonical_json(...))
    // produces for the soloe-shaped hook (no matcher, no statusMessage).
    const installed = mergeCodexHooks({}, 'echo soloe', KEY_PATH);
    const state = (installed.hooks as Record<string, unknown>)['state'] as Record<
      string,
      { trusted_hash: string }
    >;
    // SHA256 of:
    //   {"event_name":"pre_tool_use","hooks":[{"async":false,"command":"echo soloe","timeout":600,"type":"command"}]}
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          event_name: 'pre_tool_use',
          hooks: [{ async: false, command: 'echo soloe', timeout: 600, type: 'command' }]
        })
      )
      .digest('hex');
    expect(state[`${KEY_PATH}:pre_tool_use:0:0`]!.trusted_hash).toBe(`sha256:${expected}`);
  });

  it('keeps soloe at the right group_index when other hooks already exist', () => {
    const original = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'pre-existing' }] }]
      }
    };
    const installed = mergeCodexHooks(original, 'soloe', KEY_PATH);
    const groups = (installed.hooks as Record<string, unknown[]>)['PreToolUse']!;
    expect(groups).toHaveLength(2);
    const state = (installed.hooks as Record<string, unknown>)['state'] as Record<string, unknown>;
    // soloe was appended after the user's group, so its key uses index 1
    expect(state[`${KEY_PATH}:pre_tool_use:1:0`]).toBeDefined();
    expect(state[`${KEY_PATH}:pre_tool_use:0:0`]).toBeUndefined();
  });

  it('removeSoloeFromCodex drops state entries we wrote', () => {
    const installed = mergeCodexHooks({}, 'soloe', KEY_PATH);
    const cleaned = removeSoloeFromCodex(installed, KEY_PATH);
    expect((cleaned.hooks as Record<string, unknown> | undefined)?.['state']).toBeUndefined();
  });

  it('removeSoloeFromCodex preserves third-party state entries', () => {
    const installed = mergeCodexHooks({}, 'soloe', KEY_PATH);
    const hooksRoot = installed.hooks as Record<string, unknown>;
    const state = { ...(hooksRoot['state'] as Record<string, unknown>) };
    state[`${KEY_PATH}:other_event:0:0`] = { enabled: true, trusted_hash: 'sha256:other' };
    hooksRoot['state'] = state;
    const cleaned = removeSoloeFromCodex(installed, KEY_PATH);
    const remaining = (cleaned.hooks as Record<string, unknown>)['state'] as Record<string, unknown>;
    expect(remaining).toEqual({
      [`${KEY_PATH}:other_event:0:0`]: { enabled: true, trusted_hash: 'sha256:other' }
    });
  });
});

describe('mcpUrlForHost', () => {
  it('uses 127.0.0.1 for windows hosts', () => {
    const host: HookHost = { kind: 'windows', label: 'Local', homeDir: '/tmp', available: true };
    expect(mcpUrlForHost(host, 17896)).toBe('http://127.0.0.1:17896/mcp');
  });

  it('uses host.wsl.internal for WSL hosts', () => {
    const host: HookHost = {
      kind: 'wsl',
      distro: 'Ubuntu',
      label: 'WSL: Ubuntu',
      homeDir: '/tmp',
      available: true
    };
    expect(mcpUrlForHost(host, 17896)).toBe('http://host.wsl.internal:17896/mcp');
  });
});

describe('mergeClaudeMcp / removeSoloeFromClaude (pure)', () => {
  it('writes a Soloe http MCP server entry with literal Bearer token', () => {
    const merged = mergeClaudeMcp({}, { url: 'http://127.0.0.1:17896/mcp', token: 'abc' });
    const servers = merged.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.soloe).toMatchObject({
      _soloe: true,
      _soloe_version: SOLOE_HOOK_VERSION,
      type: 'http',
      url: 'http://127.0.0.1:17896/mcp',
      headers: { Authorization: 'Bearer abc' }
    });
  });

  it('preserves other mcpServers entries when merging', () => {
    const original = {
      mcpServers: {
        other: { type: 'http', url: 'http://example.com' }
      }
    };
    const merged = mergeClaudeMcp(original, { url: 'http://127.0.0.1:17896/mcp', token: 'abc' });
    const servers = merged.mcpServers as Record<string, unknown>;
    expect(servers.other).toEqual({ type: 'http', url: 'http://example.com' });
    expect(servers.soloe).toBeDefined();
  });

  it('replaces an existing soloe entry on re-merge', () => {
    const first = mergeClaudeMcp({}, { url: 'http://127.0.0.1:17896/mcp', token: 'old' });
    const second = mergeClaudeMcp(first, { url: 'http://127.0.0.1:17896/mcp', token: 'new' });
    const soloe = (second.mcpServers as Record<string, Record<string, unknown>>).soloe!;
    expect((soloe.headers as Record<string, string>).Authorization).toBe('Bearer new');
  });

  it('removeSoloeFromClaude strips the Soloe MCP entry but keeps user entries', () => {
    const original = {
      mcpServers: {
        other: { type: 'http', url: 'http://example.com' }
      }
    };
    const merged = mergeClaudeMcp(original, { url: 'http://127.0.0.1:17896/mcp', token: 'abc' });
    const cleaned = removeSoloeFromClaude(merged);
    const servers = cleaned.mcpServers as Record<string, unknown>;
    expect(servers.other).toEqual({ type: 'http', url: 'http://example.com' });
    expect(servers.soloe).toBeUndefined();
  });

  it('removeSoloeFromClaude drops mcpServers if it becomes empty', () => {
    const merged = mergeClaudeMcp({}, { url: 'http://127.0.0.1:17896/mcp', token: 'abc' });
    const cleaned = removeSoloeFromClaude(merged);
    expect(cleaned.mcpServers).toBeUndefined();
  });

  it('removeSoloeFromClaude does not touch a user-named soloe entry without marker', () => {
    const original = {
      mcpServers: {
        soloe: { type: 'http', url: 'http://user.example.com' }
      }
    };
    const cleaned = removeSoloeFromClaude(original);
    expect((cleaned.mcpServers as Record<string, unknown>).soloe).toEqual({
      type: 'http',
      url: 'http://user.example.com'
    });
  });
});

describe('mergeCodexMcp / removeSoloeFromCodex (pure)', () => {
  it('writes a Soloe MCP server entry referencing the env-var token', () => {
    const merged = mergeCodexMcp({}, { url: 'http://127.0.0.1:17896/mcp' });
    const servers = merged.mcp_servers as Record<string, Record<string, unknown>>;
    expect(servers.soloe).toMatchObject({
      _soloe: true,
      _soloe_version: SOLOE_HOOK_VERSION,
      enabled: false,
      url: 'http://127.0.0.1:17896/mcp',
      bearer_token_env_var: 'SOLOE_BRIDGE_TOKEN'
    });
  });

  it('preserves other mcp_servers entries when merging', () => {
    const original = {
      mcp_servers: { other: { url: 'http://example.com' } }
    };
    const merged = mergeCodexMcp(original, { url: 'http://127.0.0.1:17896/mcp' });
    const servers = merged.mcp_servers as Record<string, unknown>;
    expect(servers.other).toEqual({ url: 'http://example.com' });
    expect(servers.soloe).toBeDefined();
  });

  it('removeSoloeFromCodex strips the Soloe MCP entry', () => {
    const merged = mergeCodexMcp({}, { url: 'http://127.0.0.1:17896/mcp' });
    const cleaned = removeSoloeFromCodex(merged, '/home/foo/.codex/config.toml');
    expect(cleaned.mcp_servers).toBeUndefined();
  });
});

describe('HookInstaller with bridge — MCP registration', () => {
  let homeDir: string;
  let installer: HookInstaller;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'soloe-home-'));
    installer = new HookInstaller({
      hosts: [localHost(homeDir)],
      bridge: { port: 17896, token: 'tok-123' }
    });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('installClaude writes hooks to settings.json and MCP to ~/.claude.json', async () => {
    await installer.installClaude(LOCAL);
    const settings = JSON.parse(
      await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8')
    );
    expect(settings.hooks).toBeDefined();
    expect(settings.mcpServers).toBeUndefined();
    const claudeJson = JSON.parse(await fs.readFile(join(homeDir, '.claude.json'), 'utf8'));
    expect(claudeJson.mcpServers.soloe).toMatchObject({
      _soloe: true,
      _soloe_version: SOLOE_HOOK_VERSION,
      type: 'http',
      url: 'http://127.0.0.1:17896/mcp',
      headers: { Authorization: 'Bearer tok-123' }
    });
    if (process.platform !== 'win32') {
      expect((await fs.stat(join(homeDir, '.claude.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('uninstallClaude strips hooks from settings.json and MCP from ~/.claude.json', async () => {
    await installer.installClaude(LOCAL);
    await installer.uninstallClaude(LOCAL);
    const settings = JSON.parse(
      await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8')
    );
    expect(settings.hooks).toBeUndefined();
    expect(settings.mcpServers).toBeUndefined();
    const claudeJson = JSON.parse(await fs.readFile(join(homeDir, '.claude.json'), 'utf8'));
    expect(claudeJson.mcpServers).toBeUndefined();
  });

  it('installCodex writes both hooks and MCP server entry', async () => {
    await installer.installCodex(LOCAL);
    const raw = await fs.readFile(join(homeDir, '.codex', 'config.toml'), 'utf8');
    const parsed = parseToml(raw) as Record<string, unknown>;
    expect(parsed.hooks).toBeDefined();
    const servers = parsed.mcp_servers as Record<string, Record<string, unknown>>;
    expect(servers.soloe).toMatchObject({
      _soloe: true,
      _soloe_version: SOLOE_HOOK_VERSION,
      url: 'http://127.0.0.1:17896/mcp',
      bearer_token_env_var: 'SOLOE_BRIDGE_TOKEN'
    });
  });

  it('uninstallCodex strips both hooks and MCP entry', async () => {
    await installer.installCodex(LOCAL);
    await installer.uninstallCodex(LOCAL);
    const raw = await fs.readFile(join(homeDir, '.codex', 'config.toml'), 'utf8');
    const parsed = parseToml(raw) as Record<string, unknown>;
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.mcp_servers).toBeUndefined();
  });

  it('installCursor writes the authenticated global Cursor MCP entry', async () => {
    await installer.installCursor(LOCAL);
    const config = JSON.parse(await fs.readFile(join(homeDir, '.cursor', 'mcp.json'), 'utf8'));
    expect(config.mcpServers.soloe).toMatchObject({
      _soloe: true,
      _soloe_version: SOLOE_HOOK_VERSION,
      url: 'http://127.0.0.1:17896/mcp',
      headers: { Authorization: 'Bearer tok-123' }
    });
  });

  it('installCursor writes all supported interactive Cursor hooks without replacing user hooks', async () => {
    const hooksPath = join(homeDir, '.cursor', 'hooks.json');
    await fs.mkdir(join(homeDir, '.cursor'), { recursive: true });
    await fs.writeFile(hooksPath, JSON.stringify({
      version: 1,
      hooks: { afterFileEdit: [{ command: './hooks/user-format.sh' }] }
    }));

    await installer.installCursor(LOCAL);

    const config = JSON.parse(await fs.readFile(hooksPath, 'utf8'));
    expect(config.version).toBe(1);
    expect(config.hooks.afterFileEdit).toEqual(
      expect.arrayContaining([
        { command: './hooks/user-format.sh' },
        expect.objectContaining({ command: expect.stringContaining('/hook/cursor') })
      ])
    );
    expect(Object.keys(config.hooks)).toEqual(expect.arrayContaining([
      'sessionStart',
      'sessionEnd',
      'beforeSubmitPrompt',
      'stop',
      'preToolUse',
      'postToolUse',
      'postToolUseFailure',
      'subagentStart',
      'subagentStop',
      'beforeShellExecution',
      'afterShellExecution',
      'beforeMCPExecution',
      'afterMCPExecution',
      'beforeReadFile',
      'afterFileEdit',
      'preCompact',
      'afterAgentResponse',
      'afterAgentThought'
    ]));
  });

  it('uninstallCursor removes only the Soloe MCP entry', async () => {
    const path = join(homeDir, '.cursor', 'mcp.json');
    await fs.mkdir(join(homeDir, '.cursor'), { recursive: true });
    await fs.writeFile(path, JSON.stringify(mergeCursorMcp({
      mcpServers: { user: { command: 'user-mcp' } }
    }, { url: 'http://127.0.0.1:17896/mcp', token: 'tok-123' })));
    await installer.uninstallCursor(LOCAL);
    const config = JSON.parse(await fs.readFile(path, 'utf8'));
    expect(config.mcpServers).toEqual({ user: { command: 'user-mcp' } });
    expect(removeSoloeFromCursor(config)).toEqual(config);
  });

  it('uninstallCursor removes only Soloe Cursor hooks', async () => {
    const hooksPath = join(homeDir, '.cursor', 'hooks.json');
    await fs.mkdir(join(homeDir, '.cursor'), { recursive: true });
    await fs.writeFile(hooksPath, JSON.stringify(mergeCursorHooks({
      version: 1,
      hooks: { afterFileEdit: [{ command: './hooks/user-format.sh' }] }
    }, 'curl /hook/cursor $SOLOE_SESSION_ID')));

    await installer.uninstallCursor(LOCAL);

    const config = JSON.parse(await fs.readFile(hooksPath, 'utf8'));
    expect(config.hooks).toEqual({
      afterFileEdit: [{ command: './hooks/user-format.sh' }]
    });
    expect(removeSoloeFromCursorHooks(config)).toEqual(config);
  });

  it('reinstall replaces the MCP entry rather than stacking it', async () => {
    await installer.installClaude(LOCAL);
    await installer.installClaude(LOCAL);
    const claudeJson = JSON.parse(await fs.readFile(join(homeDir, '.claude.json'), 'utf8'));
    expect(Object.keys(claudeJson.mcpServers)).toEqual(['soloe']);
  });

  it('serializes concurrent mutations without corrupting agent config', async () => {
    await Promise.all([
      installer.installClaude(LOCAL),
      installer.uninstallClaude(LOCAL),
      installer.installClaude(LOCAL),
      installer.installCodex(LOCAL),
      installer.uninstallCodex(LOCAL),
      installer.installCodex(LOCAL)
    ]);

    const status = await installer.status();
    expect(status.hosts[0]).toMatchObject({
      claude: { installed: true, current: true },
      codex: { installed: true, current: true }
    });
    await expect(
      fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8')
    ).resolves.toContain('SessionStart');
    await expect(
      fs.readFile(join(homeDir, '.codex', 'config.toml'), 'utf8')
    ).resolves.toContain('[mcp_servers.soloe]');
  });

  it('routes WSL host MCP URL through host.wsl.internal', async () => {
    const wslHomeDir = mkdtempSync(join(tmpdir(), 'soloe-wsl-'));
    try {
      const multi = new HookInstaller({
        hosts: [localHost(homeDir), wslHost('Ubuntu', wslHomeDir)],
        bridge: { port: 17896, token: 'tok-123' }
      });
      await multi.installClaude({ kind: 'wsl', distro: 'Ubuntu' });
      const claudeJson = JSON.parse(
        await fs.readFile(join(wslHomeDir, '.claude.json'), 'utf8')
      );
      expect(claudeJson.mcpServers.soloe.url).toBe('http://host.wsl.internal:17896/mcp');
    } finally {
      rmSync(wslHomeDir, { recursive: true, force: true });
    }
  });

  it('status reports as not-current when MCP entry is at an older version', async () => {
    const claudeJsonPath = join(homeDir, '.claude.json');
    await fs.writeFile(
      claudeJsonPath,
      JSON.stringify({
        mcpServers: {
          soloe: { _soloe: true, _soloe_version: 5, type: 'http', url: 'http://x' }
        }
      })
    );
    const s = await installer.status();
    expect(s.hosts[0]!.claude).toEqual({ installed: true, current: false, version: 5 });
  });

  it('install scrubs a stale mcpServers.soloe left in settings.json by ≤v13', async () => {
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    await fs.mkdir(join(homeDir, '.claude'), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          soloe: {
            _soloe: true,
            _soloe_version: 13,
            type: 'http',
            url: 'http://127.0.0.1:99999/mcp',
            headers: { Authorization: 'Bearer stale' }
          }
        }
      })
    );
    await installer.installClaude(LOCAL);
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(settings.mcpServers).toBeUndefined();
    expect(settings.hooks).toBeDefined();
    const claudeJson = JSON.parse(await fs.readFile(join(homeDir, '.claude.json'), 'utf8'));
    expect(claudeJson.mcpServers.soloe._soloe_version).toBe(SOLOE_HOOK_VERSION);
    expect(claudeJson.mcpServers.soloe.headers.Authorization).toBe('Bearer tok-123');
  });

  it('migration scrub preserves user-managed mcpServers entries in settings.json', async () => {
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    await fs.mkdir(join(homeDir, '.claude'), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          soloe: { _soloe: true, _soloe_version: 13, type: 'http', url: 'http://stale' },
          other: { type: 'http', url: 'http://example.com' }
        }
      })
    );
    await installer.installClaude(LOCAL);
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(settings.mcpServers).toEqual({
      other: { type: 'http', url: 'http://example.com' }
    });
  });

  it('status reports as current when fully installed at the latest version', async () => {
    await installer.installClaude(LOCAL);
    await installer.installCodex(LOCAL);
    const s = await installer.status();
    expect(s.hosts[0]!.claude).toEqual({
      installed: true,
      current: true,
      version: SOLOE_HOOK_VERSION
    });
    expect(s.hosts[0]!.codex).toEqual({
      installed: true,
      current: true,
      version: SOLOE_HOOK_VERSION
    });
  });
});

describe('HookInstaller without bridge', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'soloe-home-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('installClaude without bridge writes hooks but no MCP entry', async () => {
    const installer = new HookInstaller({ hosts: [localHost(homeDir)] });
    await installer.installClaude(LOCAL);
    const settings = JSON.parse(
      await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8')
    );
    expect(settings.hooks).toBeDefined();
    expect(settings.mcpServers).toBeUndefined();
    const claudeJsonExists = await fs
      .stat(join(homeDir, '.claude.json'))
      .then(() => true)
      .catch(() => false);
    expect(claudeJsonExists).toBe(false);
  });
});

describe('refreshMcpForInstalledHosts', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'soloe-home-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('returns an empty result when bridge is not configured', async () => {
    const installer = new HookInstaller({ hosts: [localHost(homeDir)] });
    const res = await installer.refreshMcpForInstalledHosts();
    expect(res).toEqual({ rewritten: [], errors: [] });
  });

  it('rewrites a stale Claude MCP URL on a windows host', async () => {
    const installer = new HookInstaller({
      hosts: [localHost(homeDir)],
      bridge: { port: 17896, token: 'tok-123' }
    });
    await installer.installClaude(LOCAL);
    const claudeJsonPath = join(homeDir, '.claude.json');
    const original = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8'));
    original.mcpServers.soloe.url = 'http://127.0.0.1:99999/mcp';
    await fs.writeFile(claudeJsonPath, JSON.stringify(original, null, 2));

    const res = await installer.refreshMcpForInstalledHosts();
    expect(res.errors).toEqual([]);
    expect(res.rewritten).toEqual([{ kind: 'windows' }]);
    const after = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8'));
    expect(after.mcpServers.soloe.url).toBe('http://127.0.0.1:17896/mcp');
  });

  it('rewrites a stale Claude bearer token even when URL matches', async () => {
    const installer = new HookInstaller({
      hosts: [localHost(homeDir)],
      bridge: { port: 17896, token: 'tok-NEW' }
    });
    await installer.installClaude(LOCAL);
    const claudeJsonPath = join(homeDir, '.claude.json');
    const original = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8'));
    original.mcpServers.soloe.headers.Authorization = 'Bearer tok-OLD';
    await fs.writeFile(claudeJsonPath, JSON.stringify(original, null, 2));

    const res = await installer.refreshMcpForInstalledHosts();
    expect(res.rewritten).toEqual([{ kind: 'windows' }]);
    const after = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8'));
    expect(after.mcpServers.soloe.headers.Authorization).toBe('Bearer tok-NEW');
  });

  it('rewrites a stale Codex MCP URL on a windows host', async () => {
    const installer = new HookInstaller({
      hosts: [localHost(homeDir)],
      bridge: { port: 17896, token: 'tok-123' }
    });
    await installer.installCodex(LOCAL);
    const codexPath = join(homeDir, '.codex', 'config.toml');
    const raw = await fs.readFile(codexPath, 'utf8');
    await fs.writeFile(
      codexPath,
      raw.replace('http://127.0.0.1:17896/mcp', 'http://127.0.0.1:99999/mcp')
    );

    const res = await installer.refreshMcpForInstalledHosts();
    expect(res.errors).toEqual([]);
    expect(res.rewritten).toEqual([{ kind: 'windows' }]);
    const parsed = parseToml(await fs.readFile(codexPath, 'utf8')) as Record<string, unknown>;
    const servers = parsed['mcp_servers'] as Record<string, Record<string, unknown>>;
    expect(servers['soloe']!['url']).toBe('http://127.0.0.1:17896/mcp');
  });

  it('is a no-op when URL and token already match', async () => {
    const installer = new HookInstaller({
      hosts: [localHost(homeDir)],
      bridge: { port: 17896, token: 'tok-123' }
    });
    await installer.installClaude(LOCAL);
    await installer.installCodex(LOCAL);
    const settingsBefore = await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8');
    const claudeJsonBefore = await fs.readFile(join(homeDir, '.claude.json'), 'utf8');
    const codexBefore = await fs.readFile(join(homeDir, '.codex', 'config.toml'), 'utf8');

    const res = await installer.refreshMcpForInstalledHosts();
    expect(res.rewritten).toEqual([]);
    expect(res.errors).toEqual([]);

    const settingsAfter = await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8');
    const claudeJsonAfter = await fs.readFile(join(homeDir, '.claude.json'), 'utf8');
    const codexAfter = await fs.readFile(join(homeDir, '.codex', 'config.toml'), 'utf8');
    expect(settingsAfter).toBe(settingsBefore);
    expect(claudeJsonAfter).toBe(claudeJsonBefore);
    expect(codexAfter).toBe(codexBefore);
  });

  it('skips entries without the _soloe marker', async () => {
    const installer = new HookInstaller({
      hosts: [localHost(homeDir)],
      bridge: { port: 17896, token: 'tok-123' }
    });
    const claudeJsonPath = join(homeDir, '.claude.json');
    await fs.writeFile(
      claudeJsonPath,
      JSON.stringify({
        mcpServers: {
          soloe: { type: 'http', url: 'http://user.example.com/mcp' }
        }
      })
    );

    const res = await installer.refreshMcpForInstalledHosts();
    expect(res.rewritten).toEqual([]);
    const after = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8'));
    expect(after.mcpServers.soloe.url).toBe('http://user.example.com/mcp');
  });

  it('does nothing when the host has no config files', async () => {
    const installer = new HookInstaller({
      hosts: [localHost(homeDir)],
      bridge: { port: 17896, token: 'tok-123' }
    });
    const res = await installer.refreshMcpForInstalledHosts();
    expect(res.rewritten).toEqual([]);
    expect(res.errors).toEqual([]);
  });

  it('uses the WSL hostname probe for WSL hosts', async () => {
    const wslHomeDir = mkdtempSync(join(tmpdir(), 'soloe-wsl-'));
    try {
      const probed: string[] = [];
      const installer = new HookInstaller({
        hosts: [wslHost('Ubuntu', wslHomeDir)],
        bridge: { port: 17896, token: 'tok-123' },
        wslHostnameProbe: async (distro) => {
          probed.push(distro);
          return '172.21.0.1';
        }
      });
      // Install with the probe → URL written uses the probed IP.
      await installer.installClaude({ kind: 'wsl', distro: 'Ubuntu' });
      const claudeJsonPath = join(wslHomeDir, '.claude.json');
      const installed = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8'));
      expect(installed.mcpServers.soloe.url).toBe('http://172.21.0.1:17896/mcp');

      // Simulate a reboot where the IP drifted to a new value.
      const drifted = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8'));
      drifted.mcpServers.soloe.url = 'http://172.99.0.1:17896/mcp';
      await fs.writeFile(claudeJsonPath, JSON.stringify(drifted, null, 2));

      const res = await installer.refreshMcpForInstalledHosts();
      expect(res.errors).toEqual([]);
      expect(res.rewritten).toEqual([{ kind: 'wsl', distro: 'Ubuntu' }]);
      expect(probed).toContain('Ubuntu');
      const after = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8'));
      expect(after.mcpServers.soloe.url).toBe('http://172.21.0.1:17896/mcp');
    } finally {
      rmSync(wslHomeDir, { recursive: true, force: true });
    }
  });

  it('captures probe failures as errors without blocking other hosts', async () => {
    const wslHomeDir = mkdtempSync(join(tmpdir(), 'soloe-wsl-'));
    try {
      const installer = new HookInstaller({
        hosts: [localHost(homeDir), wslHost('Ubuntu', wslHomeDir)],
        bridge: { port: 17896, token: 'tok-123' },
        wslHostnameProbe: async () => {
          throw new Error('wsl probe boom');
        }
      });
      // Local install + drift so there's something to refresh on the windows side.
      await installer.installClaude(LOCAL);
      const claudeJsonPath = join(homeDir, '.claude.json');
      const original = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8'));
      original.mcpServers.soloe.url = 'http://127.0.0.1:99999/mcp';
      await fs.writeFile(claudeJsonPath, JSON.stringify(original, null, 2));

      // Pre-seed a stale WSL config to give the refresher something to attempt.
      await fs.writeFile(
        join(wslHomeDir, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            soloe: {
              _soloe: true,
              _soloe_version: SOLOE_HOOK_VERSION,
              type: 'http',
              url: 'http://stale:17896/mcp',
              headers: { Authorization: 'Bearer tok-123' }
            }
          }
        })
      );

      const res = await installer.refreshMcpForInstalledHosts();
      expect(res.rewritten).toEqual([{ kind: 'windows' }]);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]!.host).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
      expect(res.errors[0]!.error).toMatch(/wsl probe boom/);
    } finally {
      rmSync(wslHomeDir, { recursive: true, force: true });
    }
  });

  it('skips unavailable hosts silently', async () => {
    const installer = new HookInstaller({
      hosts: [
        {
          kind: 'wsl',
          distro: 'Broken',
          label: 'WSL: Broken',
          homeDir: '',
          available: false,
          reason: 'no $HOME'
        }
      ],
      bridge: { port: 17896, token: 'tok-123' }
    });
    const res = await installer.refreshMcpForInstalledHosts();
    expect(res).toEqual({ rewritten: [], errors: [] });
  });
});
