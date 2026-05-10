import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import {
  HookInstaller,
  mergeClaudeHooks,
  removeSoloeFromClaude,
  mergeCodexHooks,
  removeSoloeFromCodex,
  mergeClaudeMcp,
  mergeCodexMcp,
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
  it('roundtrip preserves user entries', () => {
    const original = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'user' }] }]
      }
    };
    const installed = mergeCodexHooks(original, 'soloe');
    const cleaned = removeSoloeFromCodex(installed);
    expect((cleaned.hooks as Record<string, unknown[]>)['UserPromptSubmit']).toEqual(
      original.hooks.UserPromptSubmit
    );
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
    const cleaned = removeSoloeFromCodex(merged);
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

  it('installClaude writes both hooks and MCP server entry', async () => {
    await installer.installClaude(LOCAL);
    const written = JSON.parse(
      await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8')
    );
    expect(written.hooks).toBeDefined();
    expect(written.mcpServers.soloe).toMatchObject({
      _soloe: true,
      _soloe_version: SOLOE_HOOK_VERSION,
      type: 'http',
      url: 'http://127.0.0.1:17896/mcp',
      headers: { Authorization: 'Bearer tok-123' }
    });
  });

  it('uninstallClaude strips both hooks and MCP entry', async () => {
    await installer.installClaude(LOCAL);
    await installer.uninstallClaude(LOCAL);
    const written = JSON.parse(
      await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8')
    );
    expect(written.hooks).toBeUndefined();
    expect(written.mcpServers).toBeUndefined();
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

  it('reinstall replaces the MCP entry rather than stacking it', async () => {
    await installer.installClaude(LOCAL);
    await installer.installClaude(LOCAL);
    const written = JSON.parse(
      await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8')
    );
    expect(Object.keys(written.mcpServers)).toEqual(['soloe']);
  });

  it('routes WSL host MCP URL through host.wsl.internal', async () => {
    const wslHomeDir = mkdtempSync(join(tmpdir(), 'soloe-wsl-'));
    try {
      const multi = new HookInstaller({
        hosts: [localHost(homeDir), wslHost('Ubuntu', wslHomeDir)],
        bridge: { port: 17896, token: 'tok-123' }
      });
      await multi.installClaude({ kind: 'wsl', distro: 'Ubuntu' });
      const written = JSON.parse(
        await fs.readFile(join(wslHomeDir, '.claude', 'settings.json'), 'utf8')
      );
      expect(written.mcpServers.soloe.url).toBe('http://host.wsl.internal:17896/mcp');
    } finally {
      rmSync(wslHomeDir, { recursive: true, force: true });
    }
  });

  it('status reports as not-current when MCP entry is at an older version', async () => {
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    await fs.mkdir(join(homeDir, '.claude'), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          soloe: { _soloe: true, _soloe_version: 5, type: 'http', url: 'http://x' }
        }
      })
    );
    const s = await installer.status();
    expect(s.hosts[0]!.claude).toEqual({ installed: true, current: false, version: 5 });
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
    const written = JSON.parse(
      await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8')
    );
    expect(written.hooks).toBeDefined();
    expect(written.mcpServers).toBeUndefined();
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
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    const original = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    original.mcpServers.soloe.url = 'http://127.0.0.1:99999/mcp';
    await fs.writeFile(settingsPath, JSON.stringify(original, null, 2));

    const res = await installer.refreshMcpForInstalledHosts();
    expect(res.errors).toEqual([]);
    expect(res.rewritten).toEqual([{ kind: 'windows' }]);
    const after = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(after.mcpServers.soloe.url).toBe('http://127.0.0.1:17896/mcp');
  });

  it('rewrites a stale Claude bearer token even when URL matches', async () => {
    const installer = new HookInstaller({
      hosts: [localHost(homeDir)],
      bridge: { port: 17896, token: 'tok-NEW' }
    });
    await installer.installClaude(LOCAL);
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    const original = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    original.mcpServers.soloe.headers.Authorization = 'Bearer tok-OLD';
    await fs.writeFile(settingsPath, JSON.stringify(original, null, 2));

    const res = await installer.refreshMcpForInstalledHosts();
    expect(res.rewritten).toEqual([{ kind: 'windows' }]);
    const after = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
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
    const claudeBefore = await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8');
    const codexBefore = await fs.readFile(join(homeDir, '.codex', 'config.toml'), 'utf8');

    const res = await installer.refreshMcpForInstalledHosts();
    expect(res.rewritten).toEqual([]);
    expect(res.errors).toEqual([]);

    const claudeAfter = await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8');
    const codexAfter = await fs.readFile(join(homeDir, '.codex', 'config.toml'), 'utf8');
    expect(claudeAfter).toBe(claudeBefore);
    expect(codexAfter).toBe(codexBefore);
  });

  it('skips entries without the _soloe marker', async () => {
    const installer = new HookInstaller({
      hosts: [localHost(homeDir)],
      bridge: { port: 17896, token: 'tok-123' }
    });
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    await fs.mkdir(join(homeDir, '.claude'), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          soloe: { type: 'http', url: 'http://user.example.com/mcp' }
        }
      })
    );

    const res = await installer.refreshMcpForInstalledHosts();
    expect(res.rewritten).toEqual([]);
    const after = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
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
      const installed = JSON.parse(
        await fs.readFile(join(wslHomeDir, '.claude', 'settings.json'), 'utf8')
      );
      expect(installed.mcpServers.soloe.url).toBe('http://172.21.0.1:17896/mcp');

      // Simulate a reboot where the IP drifted to a new value.
      const drifted = JSON.parse(
        await fs.readFile(join(wslHomeDir, '.claude', 'settings.json'), 'utf8')
      );
      drifted.mcpServers.soloe.url = 'http://172.99.0.1:17896/mcp';
      await fs.writeFile(
        join(wslHomeDir, '.claude', 'settings.json'),
        JSON.stringify(drifted, null, 2)
      );

      const res = await installer.refreshMcpForInstalledHosts();
      expect(res.errors).toEqual([]);
      expect(res.rewritten).toEqual([{ kind: 'wsl', distro: 'Ubuntu' }]);
      expect(probed).toContain('Ubuntu');
      const after = JSON.parse(
        await fs.readFile(join(wslHomeDir, '.claude', 'settings.json'), 'utf8')
      );
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
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      const original = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      original.mcpServers.soloe.url = 'http://127.0.0.1:99999/mcp';
      await fs.writeFile(settingsPath, JSON.stringify(original, null, 2));

      // Pre-seed a stale WSL config to give the refresher something to attempt.
      await fs.mkdir(join(wslHomeDir, '.claude'), { recursive: true });
      await fs.writeFile(
        join(wslHomeDir, '.claude', 'settings.json'),
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
