import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsUpdate
} from '@shared/types/settings.js';

const VALID_THEMES = new Set(['dark', 'light', 'system']);
const VALID_DENSITY = new Set(['comfortable', 'compact']);
const VALID_TERMINAL_FONT_SIZES = new Set([11, 12, 13, 14]);
const VALID_RUN_MODES = new Set(['windows', 'wsl']);
const VALID_SHELLS = new Set(['auto', 'bash', 'zsh', 'pwsh', 'cmd', 'custom']);

export class SettingsStore {
  private cache: Settings | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private listeners = new Set<(s: Settings) => void>();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    if (this.cache) return;
    this.cache = await this.loadFromDisk();
  }

  async get(): Promise<Settings> {
    await this.ensureLoaded();
    return clone(this.cache!);
  }

  async update(patch: SettingsUpdate): Promise<Settings> {
    await this.ensureLoaded();
    const next: Settings = {
      version: 1,
      appearance: { ...this.cache!.appearance, ...(patch.appearance ?? {}) },
      terminal: { ...this.cache!.terminal, ...(patch.terminal ?? {}) },
      defaults: { ...this.cache!.defaults, ...(patch.defaults ?? {}) },
      binaries: mergeBinaries(this.cache!.binaries, patch.binaries)
    };
    validateSettings(next);
    this.cache = next;
    await this.persist();
    for (const l of this.listeners) {
      try { l(clone(next)); } catch { /* listener error */ }
    }
    return clone(next);
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.cache) await this.init();
  }

  private async loadFromDisk(): Promise<Settings> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return clone(DEFAULT_SETTINGS);
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.backupCorruptFile(raw);
      return clone(DEFAULT_SETTINGS);
    }
    return parseSettings(parsed);
  }

  private async backupCorruptFile(content: string): Promise<void> {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      await fs.writeFile(backupPath, content, 'utf8');
    } catch {
      // best-effort
    }
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify(this.cache!, null, 2);
    this.writeQueue = this.writeQueue.then(() => atomicWrite(this.filePath, payload));
    await this.writeQueue;
  }
}

function mergeBinaries(
  current: Settings['binaries'],
  patch: Partial<Settings['binaries']> | undefined
): Settings['binaries'] {
  if (!patch) return { ...current };
  const out: Settings['binaries'] = { ...current };
  for (const k of Object.keys(patch) as (keyof Settings['binaries'])[]) {
    const v = patch[k];
    if (v === undefined || v === '') {
      delete out[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}

function parseSettings(raw: unknown): Settings {
  if (!isObject(raw)) return clone(DEFAULT_SETTINGS);
  const appearance = isObject(raw['appearance']) ? raw['appearance'] : {};
  const terminal = isObject(raw['terminal']) ? raw['terminal'] : {};
  const defaults = isObject(raw['defaults']) ? raw['defaults'] : {};
  const binaries = isObject(raw['binaries']) ? raw['binaries'] : {};

  const out: Settings = {
    version: 1,
    appearance: {
      theme: pickEnum(appearance['theme'], VALID_THEMES, DEFAULT_SETTINGS.appearance.theme) as Settings['appearance']['theme'],
      density: pickEnum(appearance['density'], VALID_DENSITY, DEFAULT_SETTINGS.appearance.density) as Settings['appearance']['density']
    },
    terminal: {
      fontSize: pickTerminalFontSize(terminal['fontSize'] ?? appearance['fontSize'])
    },
    defaults: {
      runMode: pickEnum(defaults['runMode'], VALID_RUN_MODES, DEFAULT_SETTINGS.defaults.runMode) as Settings['defaults']['runMode'],
      shell: pickEnum(defaults['shell'], VALID_SHELLS, DEFAULT_SETTINGS.defaults.shell) as Settings['defaults']['shell'],
      cwd: typeof defaults['cwd'] === 'string' && defaults['cwd'] ? defaults['cwd'] : DEFAULT_SETTINGS.defaults.cwd,
      ...(typeof defaults['wslDistro'] === 'string' && defaults['wslDistro'] ? { wslDistro: defaults['wslDistro'] } : {})
    },
    binaries: filterStringRecord(binaries)
  };
  validateSettings(out);
  return out;
}

function pickEnum(value: unknown, valid: Set<unknown>, fallback: string): string {
  return valid.has(value) ? (value as string) : fallback;
}

function pickTerminalFontSize(value: unknown): Settings['terminal']['fontSize'] {
  return VALID_TERMINAL_FONT_SIZES.has(value as number)
    ? (value as Settings['terminal']['fontSize'])
    : DEFAULT_SETTINGS.terminal.fontSize;
}

function filterStringRecord(raw: Record<string, unknown>): Settings['binaries'] {
  const allowed: (keyof Settings['binaries'])[] = ['claude', 'codex', 'git', 'gh', 'fd', 'rg', 'editor'];
  const out: Settings['binaries'] = {};
  for (const k of allowed) {
    const v = raw[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

function validateSettings(s: Settings): void {
  if (s.version !== 1) throw new Error(`Unsupported settings version: ${s.version}`);
  if (!VALID_THEMES.has(s.appearance.theme)) throw new Error(`Invalid theme: ${s.appearance.theme}`);
  if (!VALID_DENSITY.has(s.appearance.density)) throw new Error(`Invalid density: ${s.appearance.density}`);
  if (!VALID_TERMINAL_FONT_SIZES.has(s.terminal.fontSize)) {
    throw new Error(`Invalid terminal.fontSize: ${s.terminal.fontSize}`);
  }
  if (!VALID_RUN_MODES.has(s.defaults.runMode)) throw new Error(`Invalid runMode: ${s.defaults.runMode}`);
  if (!VALID_SHELLS.has(s.defaults.shell)) throw new Error(`Invalid shell: ${s.defaults.shell}`);
  if (typeof s.defaults.cwd !== 'string' || !s.defaults.cwd) {
    throw new Error('defaults.cwd must be a non-empty string');
  }
  if (s.defaults.runMode === 'wsl' && s.defaults.wslDistro !== undefined && !s.defaults.wslDistro) {
    throw new Error('wslDistro must be a non-empty string when set');
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
