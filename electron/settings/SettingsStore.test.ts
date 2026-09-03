import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SettingsStore } from './SettingsStore.js';
import { DEFAULT_SETTINGS } from '@shared/types/settings.js';

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-settings-'));
  storePath = path.join(tmpDir, 'settings.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('SettingsStore — defaults', () => {
  it('returns defaults when file does not exist', async () => {
    const store = new SettingsStore(path.join(tmpDir, 'no-such.json'));
    const s = await store.get();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('does not write a file just by reading defaults', async () => {
    const store = new SettingsStore(path.join(tmpDir, 'no-such.json'));
    await store.get();
    const exists = await fs.access(path.join(tmpDir, 'no-such.json')).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('enables the Element Source Inspector and its verified shortcut by default', async () => {
    const settings = await new SettingsStore(path.join(tmpDir, 'default.json')).get();
    expect(settings.browser.elementSourceInspectorEnabled).toBe(true);
    expect(settings.shortcuts.elementSourceInspector).toEqual(['Ctrl', 'Alt', 'Shift', 'S']);
  });

  it('does not launch the Soloe Client on startup by default', async () => {
    const settings = await new SettingsStore(path.join(tmpDir, 'default.json')).get();
    expect(settings.startup.launchSoloeClient).toBe(false);
  });

  it('keeps 10,000 terminal replay lines by default', async () => {
    const settings = await new SettingsStore(path.join(tmpDir, 'history-default.json')).get();
    expect(settings.terminal.replayLineLimit).toBe(10_000);
  });

  it('follows the system color scheme by default', async () => {
    const settings = await new SettingsStore(path.join(tmpDir, 'theme-default.json')).get();
    expect(settings.appearance.theme).toBe('system');
  });

  it('keeps Session event debugging off by default', async () => {
    const settings = await new SettingsStore(path.join(tmpDir, 'debug-default.json')).get();
    expect(settings.debug.sessionEvents).toBe(false);
  });

  it('selects native Linux defaults for the Linux build', async () => {
    const store = new SettingsStore(path.join(tmpDir, 'linux.json'), 'linux');
    const s = await store.get();
    expect(s.defaults.runMode).toBe('linux');
    expect(s.defaults.wslDistro).toBeUndefined();
    expect(s.backend.placement).toBe('linux');
    expect(s.startup.launchSoloeClient).toBe(false);
    await expect(store.update({ defaults: { runMode: 'wsl' } })).rejects.toThrow(
      /not available on linux/
    );
  });

  it('creates and reloads native macOS defaults on the macOS build', async () => {
    const macPath = path.join(tmpDir, 'macos.json');
    const store = new SettingsStore(macPath, 'macos');
    const defaults = await store.get();

    expect(defaults.defaults.runMode).toBe('macos');
    expect(defaults.defaults.wslDistro).toBeUndefined();
    expect(defaults.backend.placement).toBe('macos');
    expect(defaults.startup.launchSoloeClient).toBe(false);

    await store.update({ defaults: { shell: 'zsh', runMode: 'macos' } });
    await expect(new SettingsStore(macPath, 'macos').get()).resolves.toMatchObject({
      backend: { placement: 'macos' },
      defaults: { runMode: 'macos', shell: 'zsh' }
    });
    await expect(store.update({ defaults: { runMode: 'wsl' } })).rejects.toThrow(
      /not available on macos/
    );
  });

  it('migrates a copied Windows default to native Linux', async () => {
    await fs.writeFile(storePath, JSON.stringify(DEFAULT_SETTINGS), 'utf8');
    const store = new SettingsStore(storePath, 'linux');
    const migrated = await store.get();
    expect(migrated.defaults.runMode).toBe('linux');
    expect(migrated.backend.placement).toBe('linux');
  });

});

describe('SettingsStore — update', () => {
  it('can disable client startup after migrating copied Windows settings on Linux', async () => {
    await fs.writeFile(storePath, JSON.stringify({
      ...DEFAULT_SETTINGS,
      startup: { launchSoloeClient: true }
    }), 'utf8');
    const store = new SettingsStore(storePath, 'linux');

    const updated = await store.update({ startup: { launchSoloeClient: false } });

    expect(updated.backend.placement).toBe('linux');
    expect(updated.startup.launchSoloeClient).toBe(false);
    await expect(new SettingsStore(storePath, 'linux').get()).resolves.toMatchObject({
      backend: { placement: 'linux' },
      startup: { launchSoloeClient: false }
    });
  });

  it('persists an explicit Soloe Client startup opt-in', async () => {
    const store = new SettingsStore(storePath);
    await store.update({ startup: { launchSoloeClient: true } });

    await expect(new SettingsStore(storePath).get()).resolves.toMatchObject({
      startup: { launchSoloeClient: true }
    });
  });

  it('persists the inspector setting and customized shortcut', async () => {
    const store = new SettingsStore(storePath);
    await store.update({
      browser: { elementSourceInspectorEnabled: false },
      shortcuts: { elementSourceInspector: ['Ctrl', 'Alt', 'Shift', 'X'] }
    });
    const reloaded = new SettingsStore(storePath);
    await expect(reloaded.get()).resolves.toMatchObject({
      browser: { elementSourceInspectorEnabled: false },
      shortcuts: { elementSourceInspector: ['Ctrl', 'Alt', 'Shift', 'X'] }
    });
  });

  it('persists the Session event debugger opt-in', async () => {
    const store = new SettingsStore(storePath);
    await store.update({ debug: { sessionEvents: true } });

    await expect(new SettingsStore(storePath).get()).resolves.toMatchObject({
      debug: { sessionEvents: true }
    });
  });
  it('persists the backend placement independently from session run mode', async () => {
    const store = new SettingsStore(storePath);
    const updated = await store.update({
      backend: {
        placement: 'wsl',
        wslDistro: 'Debian',
        wslRepositoryRoot: '/home/me/src/soloe'
      }
    });
    expect(updated.backend).toEqual({
      placement: 'wsl',
      wslDistro: 'Debian',
      wslRepositoryRoot: '/home/me/src/soloe'
    });
    expect(updated.defaults.runMode).toBe(DEFAULT_SETTINGS.defaults.runMode);
  });

  it('rejects an invalid WSL repository path', async () => {
    const store = new SettingsStore(storePath);
    await expect(
      store.update({
        backend: {
          placement: 'wsl',
          wslRepositoryRoot: 'C:\\src\\soloe'
        }
      })
    ).rejects.toThrow(/absolute Linux path/);
  });

  it('merges appearance updates', async () => {
    const store = new SettingsStore(storePath);
    const updated = await store.update({ appearance: { theme: 'light' } });
    expect(updated.appearance.theme).toBe('light');
    expect(updated.terminal).toEqual(DEFAULT_SETTINGS.terminal);
  });

  it('merges terminal updates', async () => {
    const store = new SettingsStore(storePath);
    const updated = await store.update({ terminal: { fontSize: 14 } });
    expect(updated.terminal.fontSize).toBe(14);
    expect(updated.terminal.confirmDeleteTabs).toBe(true);
    expect(updated.appearance).toEqual(DEFAULT_SETTINGS.appearance);
  });

  it('merges terminal delete confirmation updates', async () => {
    const store = new SettingsStore(storePath);
    const updated = await store.update({ terminal: { confirmDeleteTabs: false } });
    expect(updated.terminal.confirmDeleteTabs).toBe(false);
    expect(updated.terminal.fontSize).toBe(DEFAULT_SETTINGS.terminal.fontSize);
  });

  it('merges terminal replay line limit updates', async () => {
    const store = new SettingsStore(storePath);
    const updated = await store.update({ terminal: { replayLineLimit: 25_000 } });
    expect(updated.terminal.replayLineLimit).toBe(25_000);
    expect(updated.terminal.fontSize).toBe(DEFAULT_SETTINGS.terminal.fontSize);
  });

  it('merges and validates browser residency updates', async () => {
    const store = new SettingsStore(storePath);
    const updated = await store.update({ browser: { maxResidentTabs: 2 } });
    expect(updated.browser.maxResidentTabs).toBe(2);
    expect(updated.browser.pauseAutoResumeMinutes).toBe(
      DEFAULT_SETTINGS.browser.pauseAutoResumeMinutes
    );
    await expect(
      store.update({ browser: { maxResidentTabs: 0 } })
    ).rejects.toThrow(/Invalid browser\.maxResidentTabs/);
  });

  it('merges default new session kind updates', async () => {
    const store = new SettingsStore(storePath);
    const updated = await store.update({ defaults: { newSessionKind: 'claude_code' } });
    expect(updated.defaults.newSessionKind).toBe('claude_code');
    expect(updated.defaults.runMode).toBe(DEFAULT_SETTINGS.defaults.runMode);
  });

  it('preserves model ids that are newer than the local catalog', async () => {
    const store = new SettingsStore(storePath);
    const updated = await store.update({
      models: { textGeneration: { provider: 'codex', id: 'gpt-future' } }
    });

    expect(updated.models.textGeneration).toEqual({
      provider: 'codex',
      id: 'gpt-future'
    });
    await expect(new SettingsStore(storePath).get()).resolves.toEqual(
      expect.objectContaining({
        models: expect.objectContaining({
          textGeneration: { provider: 'codex', id: 'gpt-future' }
        })
      })
    );
  });

  it('removes a binary path when set to empty string', async () => {
    const store = new SettingsStore(storePath);
    await store.update({ binaries: { claude: '/usr/bin/claude' } });
    const after = await store.update({ binaries: { claude: '' } });
    expect(after.binaries.claude).toBeUndefined();
  });

  it('rejects invalid theme value', async () => {
    const store = new SettingsStore(storePath);
    await expect(
      store.update({ appearance: { theme: 'rainbow' as never } })
    ).rejects.toThrow(/Invalid theme/);
  });

  it('rejects invalid terminal font size', async () => {
    const store = new SettingsStore(storePath);
    await expect(
      store.update({ terminal: { fontSize: 99 as never } })
    ).rejects.toThrow(/Invalid terminal\.fontSize/);
  });

  it('rejects invalid terminal delete confirmation value', async () => {
    const store = new SettingsStore(storePath);
    await expect(
      store.update({ terminal: { confirmDeleteTabs: 'no' as never } })
    ).rejects.toThrow(/Invalid terminal\.confirmDeleteTabs/);
  });

  it('rejects unsupported terminal replay line limits', async () => {
    const store = new SettingsStore(storePath);
    await expect(
      store.update({ terminal: { replayLineLimit: 1234 as never } })
    ).rejects.toThrow(/Invalid terminal\.replayLineLimit/);
  });

  it('rejects invalid default new session kind', async () => {
    const store = new SettingsStore(storePath);
    await expect(
      store.update({ defaults: { newSessionKind: 'editor' as never } })
    ).rejects.toThrow(/Invalid newSessionKind/);
  });
});

describe('SettingsStore — migration', () => {
  it('extends the legacy default paused-tab timeout without overriding later preferences', async () => {
    const legacy = {
      ...DEFAULT_SETTINGS,
      version: 1,
      browser: { ...DEFAULT_SETTINGS.browser, pauseAutoResumeMinutes: 5 }
    };
    await fs.writeFile(storePath, JSON.stringify(legacy), 'utf8');
    const migrated = await new SettingsStore(storePath).get();
    expect(migrated.version).toBe(3);
    expect(migrated.browser.pauseAutoResumeMinutes).toBe(30);

    await new SettingsStore(storePath).update({ browser: { pauseAutoResumeMinutes: 5 } });
    expect((await new SettingsStore(storePath).get()).browser.pauseAutoResumeMinutes).toBe(5);
  });

  it('fills in defaults.cwd when missing from on-disk settings', async () => {
    const onDisk = {
      version: 1,
      appearance: { theme: 'dark', density: 'comfortable', fontSize: 13 },
      defaults: { runMode: 'wsl', wslDistro: 'Ubuntu', shell: 'auto' },
      binaries: {}
    };
    await fs.writeFile(storePath, JSON.stringify(onDisk), 'utf8');
    const store = new SettingsStore(storePath);
    const s = await store.get();
    expect(s.defaults.cwd).toBe('~');
    expect('density' in s.appearance).toBe(false);
    expect('fontSize' in s.appearance).toBe(false);
    expect(s.terminal.fontSize).toBe(13);
    expect(s.terminal.confirmDeleteTabs).toBe(true);
    expect(s.terminal.replayLineLimit).toBe(10_000);
    expect(s.defaults.newSessionKind).toBe('terminal');
    expect(s.browser.maxResidentTabs).toBe(DEFAULT_SETTINGS.browser.maxResidentTabs);
    expect(s.backend).toEqual(DEFAULT_SETTINGS.backend);
    expect(s.startup.launchSoloeClient).toBe(false);
    expect(s.debug).toEqual(DEFAULT_SETTINGS.debug);
  });

  it('replaces the hidden version 2 full-history setting with the default line limit', async () => {
    await fs.writeFile(storePath, JSON.stringify({
      ...DEFAULT_SETTINGS,
      version: 2,
      terminal: { ...DEFAULT_SETTINGS.terminal, keepFullHistory: true }
    }), 'utf8');

    const migrated = await new SettingsStore(storePath).get();

    expect(migrated.version).toBe(3);
    expect(migrated.terminal.replayLineLimit).toBe(10_000);
  });

  it('migrates legacy appearance.fontSize to terminal.fontSize', async () => {
    const onDisk = {
      version: 1,
      appearance: { theme: 'dark', density: 'comfortable', fontSize: 14 },
      defaults: { runMode: 'wsl', wslDistro: 'Ubuntu', shell: 'auto', cwd: '~' },
      binaries: {}
    };
    await fs.writeFile(storePath, JSON.stringify(onDisk), 'utf8');
    const store = new SettingsStore(storePath);
    const s = await store.get();
    expect(s.terminal.fontSize).toBe(14);
    expect('density' in s.appearance).toBe(false);
    expect('fontSize' in s.appearance).toBe(false);
  });

  it('seeds quick launch defaults for old empty settings once', async () => {
    const onDisk = {
      version: 1,
      appearance: { theme: 'dark' },
      defaults: { runMode: 'wsl', wslDistro: 'Ubuntu', shell: 'auto', cwd: '~' },
      binaries: {},
      quickLaunch: []
    };
    await fs.writeFile(storePath, JSON.stringify(onDisk), 'utf8');
    const store = new SettingsStore(storePath);
    const s = await store.get();
    expect(s.quickLaunch.length).toBe(DEFAULT_SETTINGS.quickLaunch.length);
    expect(s.quickLaunchDefaultsSeeded).toBe(true);
  });

  it('preserves an explicitly removed quick launch list after seeding', async () => {
    const onDisk = {
      version: 1,
      appearance: { theme: 'dark' },
      defaults: { runMode: 'wsl', wslDistro: 'Ubuntu', shell: 'auto', cwd: '~' },
      binaries: {},
      quickLaunch: [],
      quickLaunchDefaultsSeeded: true
    };
    await fs.writeFile(storePath, JSON.stringify(onDisk), 'utf8');
    const store = new SettingsStore(storePath);
    const s = await store.get();
    expect(s.quickLaunch).toEqual([]);
    expect(s.quickLaunchDefaultsSeeded).toBe(true);
  });
});

describe('SettingsStore — disk round-trip', () => {
  it('persists across instances pointing at the same file', async () => {
    const a = new SettingsStore(storePath);
    await a.update({ appearance: { theme: 'light' }, binaries: { claude: '/x/claude' } });
    const b = new SettingsStore(storePath);
    const fromDisk = await b.get();
    expect(fromDisk.appearance.theme).toBe('light');
    expect(fromDisk.binaries.claude).toBe('/x/claude');
  });

  it('backs up corrupt JSON and starts with defaults', async () => {
    await fs.writeFile(storePath, '{ broken json', 'utf8');
    const store = new SettingsStore(storePath);
    expect((await store.get()).appearance).toEqual(DEFAULT_SETTINGS.appearance);
    const entries = await fs.readdir(tmpDir);
    expect(entries.some((f) => f.startsWith('settings.json.corrupt-'))).toBe(true);
  });
});

describe('SettingsStore — listeners', () => {
  it('notifies subscribers on update', async () => {
    const store = new SettingsStore(storePath);
    let lastTheme: string | null = null;
    const off = store.onChange((s) => {
      lastTheme = s.appearance.theme;
    });
    await store.update({ appearance: { theme: 'light' } });
    expect(lastTheme).toBe('light');
    off();
    await store.update({ appearance: { theme: 'dark' } });
    expect(lastTheme).toBe('light'); // unchanged after detach
  });
});
