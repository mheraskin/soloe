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
  SOLOE_HOOK_VERSION
} from './HookInstaller.js';

describe('HookInstaller', () => {
  let homeDir: string;
  let projectDir: string;
  let installer: HookInstaller;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'soloe-home-'));
    projectDir = mkdtempSync(join(tmpdir(), 'soloe-proj-'));
    installer = new HookInstaller({ homeDir });
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe('claude install/uninstall', () => {
    it('writes hooks for all supported events on first install', async () => {
      await installer.installClaude('user');
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
          'SessionEnd',
          'PreCompact',
          'SubagentStop'
        ])
      );
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
      await installer.installClaude('user');
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
      await installer.installClaude('user');
      await installer.uninstallClaude('user');
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
      await installer.installClaude('user');
      await installer.uninstallClaude('user');
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
      await installer.installClaude('user');
      const entries = await fs.readdir(join(homeDir, '.claude'));
      expect(entries.some((e) => e.includes('soloe-backup'))).toBe(true);
    });

    it('routes by scope for project-local files', async () => {
      await installer.installClaude('project_local', projectDir);
      const path = join(projectDir, '.claude', 'settings.local.json');
      const exists = await fs
        .stat(path)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it('routes by scope for project files', async () => {
      await installer.installClaude('project', projectDir);
      const path = join(projectDir, '.claude', 'settings.json');
      const exists = await fs
        .stat(path)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it('throws when project scope is missing projectPath', async () => {
      await expect(installer.installClaude('project')).rejects.toThrow(/projectPath/);
    });

    it('reinstalling does not stack duplicate entries', async () => {
      await installer.installClaude('user');
      await installer.installClaude('user');
      const written = JSON.parse(
        await fs.readFile(join(homeDir, '.claude', 'settings.json'), 'utf8')
      );
      expect(written.hooks.UserPromptSubmit).toHaveLength(1);
    });
  });

  describe('codex install/uninstall', () => {
    it('writes hooks for all supported events on first install', async () => {
      await installer.installCodex();
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
      expect((parsed as { features?: { codex_hooks?: boolean } }).features?.codex_hooks).toBe(true);
    });

    it('preserves user keys when merging', async () => {
      const path = join(homeDir, '.codex', 'config.toml');
      await fs.mkdir(join(homeDir, '.codex'), { recursive: true });
      await fs.writeFile(
        path,
        ['model = "gpt-5"', '', '[[hooks.UserPromptSubmit]]', 'type = "command"', 'command = "user-script"'].join(
          '\n'
        )
      );
      await installer.installCodex();
      const parsed = parseToml(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
      expect(parsed['model']).toBe('gpt-5');
      const ups = (parsed['hooks'] as Record<string, unknown[]>)['UserPromptSubmit']!;
      expect(ups).toHaveLength(2);
      expect((ups[1] as { _soloe_version?: number })._soloe_version).toBe(SOLOE_HOOK_VERSION);
    });

    it('install→uninstall removes only Soloe entries', async () => {
      const path = join(homeDir, '.codex', 'config.toml');
      await fs.mkdir(join(homeDir, '.codex'), { recursive: true });
      await fs.writeFile(
        path,
        ['model = "gpt-5"', '', '[[hooks.UserPromptSubmit]]', 'type = "command"', 'command = "user-script"'].join(
          '\n'
        )
      );
      await installer.installCodex();
      await installer.uninstallCodex();
      const parsed = parseToml(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
      expect(parsed['model']).toBe('gpt-5');
      const ups = (parsed['hooks'] as Record<string, unknown[]>)['UserPromptSubmit']!;
      expect(ups).toHaveLength(1);
      expect((ups[0] as { command: string }).command).toBe('user-script');
    });

    it('reinstalling does not stack duplicate entries', async () => {
      await installer.installCodex();
      await installer.installCodex();
      const parsed = parseToml(
        await fs.readFile(join(homeDir, '.codex', 'config.toml'), 'utf8')
      ) as Record<string, Record<string, unknown[]>>;
      expect(parsed['hooks']?.['SessionStart']).toHaveLength(1);
    });

    it('replaces legacy lowercase Soloe hook entries on install', async () => {
      const path = join(homeDir, '.codex', 'config.toml');
      await fs.mkdir(join(homeDir, '.codex'), { recursive: true });
      await fs.writeFile(
        path,
        [
          '[[hooks.session_start]]',
          'type = "command"',
          'command = "old-soloe"',
          '_soloe = true'
        ].join('\n')
      );
      await installer.installCodex();
      const parsed = parseToml(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
      const hooks = parsed['hooks'] as Record<string, unknown[]>;
      expect(hooks['session_start']).toBeUndefined();
      expect(hooks['SessionStart']).toHaveLength(1);
    });
  });

  describe('status()', () => {
    it('reports nothing when no files exist', async () => {
      const s = await installer.status();
      expect(s).toEqual({
        claude: {
          user: { installed: false, current: false },
          project: { installed: false, current: false },
          projectLocal: { installed: false, current: false }
        },
        codex: { installed: false, current: false }
      });
    });

    it('reports installed scopes after install', async () => {
      await installer.installClaude('user');
      await installer.installCodex();
      const s = await installer.status();
      expect(s.claude.user).toEqual({
        installed: true,
        current: true,
        version: SOLOE_HOOK_VERSION
      });
      expect(s.codex).toEqual({
        installed: true,
        current: true,
        version: SOLOE_HOOK_VERSION
      });
    });

    it('reports project + project_local when projectPath provided', async () => {
      await installer.installClaude('project', projectDir);
      await installer.installClaude('project_local', projectDir);
      const s = await installer.status(projectDir);
      expect(s.claude.project.current).toBe(true);
      expect(s.claude.projectLocal.current).toBe(true);
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
        ['[[hooks.session_start]]', 'type = "command"', 'command = "old"', '_soloe = true'].join(
          '\n'
        )
      );
      const s = await installer.status();
      expect(s.claude.user).toEqual({ installed: true, current: false, version: 1 });
      expect(s.codex).toEqual({ installed: true, current: false, version: 1 });
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
        UserPromptSubmit: [{ type: 'command', command: 'user' }]
      }
    };
    const installed = mergeCodexHooks(original, 'soloe');
    const cleaned = removeSoloeFromCodex(installed);
    expect((cleaned.hooks as Record<string, unknown[]>)['UserPromptSubmit']).toEqual(
      original.hooks.UserPromptSubmit
    );
  });
});
