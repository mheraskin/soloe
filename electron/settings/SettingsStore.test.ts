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
});

describe('SettingsStore — update', () => {
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

  it('merges default new session kind updates', async () => {
    const store = new SettingsStore(storePath);
    const updated = await store.update({ defaults: { newSessionKind: 'claude_code' } });
    expect(updated.defaults.newSessionKind).toBe('claude_code');
    expect(updated.defaults.runMode).toBe(DEFAULT_SETTINGS.defaults.runMode);
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

  it('rejects invalid default new session kind', async () => {
    const store = new SettingsStore(storePath);
    await expect(
      store.update({ defaults: { newSessionKind: 'editor' as never } })
    ).rejects.toThrow(/Invalid newSessionKind/);
  });
});

describe('SettingsStore — migration', () => {
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
    expect(s.defaults.newSessionKind).toBe('standard_terminal');
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
