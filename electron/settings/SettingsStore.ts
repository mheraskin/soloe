import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  MODEL_CATALOG,
  type ModelSelection,
  type QuickLaunchPreset,
  type Settings,
  type SettingsModels,
  type SettingsUpdate
} from '@shared/types/settings.js';
import { isAgentProvider } from '@shared/types/sessions.js';

const VALID_THEMES = new Set(['dark', 'light', 'system']);
const VALID_TERMINAL_FONT_SIZES = new Set([11, 12, 13, 14]);
const VALID_DIFF_FONT_SIZES = new Set([11, 12, 13, 14, 15, 16]);
const VALID_RUN_MODES = new Set(['windows', 'wsl']);
const VALID_SHELLS = new Set(['auto', 'bash', 'zsh', 'pwsh', 'cmd', 'custom']);
const VALID_SESSION_LAUNCH_KINDS = new Set(['terminal', 'claude_code', 'codex']);
const VALID_MODEL_PROVIDERS = new Set(['codex', 'claude']);
const VALID_MODEL_TASKS: (keyof SettingsModels)[] = ['textGeneration', 'gitCommitGeneration', 'worktreeOverview'];

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
      diff: { ...this.cache!.diff, ...(patch.diff ?? {}) },
      browser: { ...this.cache!.browser, ...(patch.browser ?? {}) },
      defaults: { ...this.cache!.defaults, ...(patch.defaults ?? {}) },
      binaries: mergeBinaries(this.cache!.binaries, patch.binaries),
      models: mergeModels(this.cache!.models, patch.models),
      quickLaunch: patch.quickLaunch ?? [...this.cache!.quickLaunch],
      quickLaunchDefaultsSeeded: patch.quickLaunchDefaultsSeeded ?? (
        patch.quickLaunch ? true : this.cache!.quickLaunchDefaultsSeeded
      ),
      integrations: { ...this.cache!.integrations, ...(patch.integrations ?? {}) },
      notes: { ...this.cache!.notes, ...(patch.notes ?? {}) }
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

function mergeModels(
  current: SettingsModels,
  patch: Partial<SettingsModels> | undefined
): SettingsModels {
  const out: SettingsModels = { ...current };
  if (!patch) return out;
  for (const task of VALID_MODEL_TASKS) {
    if (!(task in patch)) continue;
    const value = patch[task];
    if (!value) {
      delete out[task];
    } else if (parseModelSelection(value)) {
      out[task] = parseModelSelection(value)!;
    }
  }
  return out;
}

function parseModelSelection(raw: unknown): ModelSelection | null {
  if (!isObject(raw)) return null;
  const provider = raw['provider'];
  const id = raw['id'];
  if (typeof provider !== 'string' || !VALID_MODEL_PROVIDERS.has(provider)) return null;
  if (typeof id !== 'string' || !id.trim()) return null;
  const known = MODEL_CATALOG.find((m) => m.provider === provider && m.id === id);
  if (!known) return null;
  return { provider: provider as ModelSelection['provider'], id };
}

function parseModels(raw: unknown): SettingsModels {
  if (!isObject(raw)) return cloneDefaultModels();
  const out: SettingsModels = {};
  for (const task of VALID_MODEL_TASKS) {
    const parsed = parseModelSelection(raw[task]);
    if (parsed) out[task] = parsed;
  }
  // If the persisted value is missing entries, fall back to defaults so the
  // user always has something selected after upgrade or fresh install.
  if (!out.textGeneration && DEFAULT_SETTINGS.models.textGeneration) {
    out.textGeneration = { ...DEFAULT_SETTINGS.models.textGeneration };
  }
  if (!out.gitCommitGeneration && DEFAULT_SETTINGS.models.gitCommitGeneration) {
    out.gitCommitGeneration = { ...DEFAULT_SETTINGS.models.gitCommitGeneration };
  }
  if (!out.worktreeOverview && DEFAULT_SETTINGS.models.worktreeOverview) {
    out.worktreeOverview = { ...DEFAULT_SETTINGS.models.worktreeOverview };
  }
  return out;
}

function cloneDefaultModels(): SettingsModels {
  return clone(DEFAULT_SETTINGS.models);
}

function parseSettings(raw: unknown): Settings {
  if (!isObject(raw)) return clone(DEFAULT_SETTINGS);
  const appearance = isObject(raw['appearance']) ? raw['appearance'] : {};
  const terminal = isObject(raw['terminal']) ? raw['terminal'] : {};
  const diff = isObject(raw['diff']) ? raw['diff'] : {};
  const browser = isObject(raw['browser']) ? raw['browser'] : {};
  const defaults = isObject(raw['defaults']) ? raw['defaults'] : {};
  const binaries = isObject(raw['binaries']) ? raw['binaries'] : {};

  const hasQuickLaunch = Object.hasOwn(raw, 'quickLaunch');
  const quickLaunchDefaultsSeeded = pickBoolean(
    raw['quickLaunchDefaultsSeeded'],
    hasQuickLaunch && Array.isArray(raw['quickLaunch']) && (raw['quickLaunch'] as unknown[]).length > 0
  );
  const out: Settings = {
    version: 1,
    appearance: {
      theme: pickEnum(appearance['theme'], VALID_THEMES, DEFAULT_SETTINGS.appearance.theme) as Settings['appearance']['theme']
    },
    terminal: {
      fontSize: pickTerminalFontSize(terminal['fontSize'] ?? appearance['fontSize']),
      confirmDeleteTabs: pickBoolean(
        terminal['confirmDeleteTabs'],
        DEFAULT_SETTINGS.terminal.confirmDeleteTabs
      )
    },
    diff: {
      fontSize: pickDiffFontSize(diff['fontSize'])
    },
    browser: {
      pauseAutoResumeMinutes: pickPauseAutoResumeMinutes(browser['pauseAutoResumeMinutes'])
    },
    defaults: {
      runMode: pickEnum(defaults['runMode'], VALID_RUN_MODES, DEFAULT_SETTINGS.defaults.runMode) as Settings['defaults']['runMode'],
      shell: pickEnum(defaults['shell'], VALID_SHELLS, DEFAULT_SETTINGS.defaults.shell) as Settings['defaults']['shell'],
      cwd: typeof defaults['cwd'] === 'string' && defaults['cwd'] ? defaults['cwd'] : DEFAULT_SETTINGS.defaults.cwd,
      newSessionKind: pickSessionLaunchKind(defaults['newSessionKind']),
      ...(typeof defaults['wslDistro'] === 'string' && defaults['wslDistro'] ? { wslDistro: defaults['wslDistro'] } : {})
    },
    binaries: filterStringRecord(binaries),
    models: parseModels(raw['models']),
    quickLaunch: parseQuickLaunch(raw['quickLaunch'], quickLaunchDefaultsSeeded),
    quickLaunchDefaultsSeeded: true,
    integrations: parseIntegrations(raw['integrations']),
    notes: parseNotes(raw['notes'])
  };
  validateSettings(out);
  return out;
}

function parseNotes(raw: unknown): Settings['notes'] {
  if (!isObject(raw)) return { ...DEFAULT_SETTINGS.notes };
  return {
    draftsPerWorktree: pickBoolean(
      raw['draftsPerWorktree'],
      DEFAULT_SETTINGS.notes.draftsPerWorktree
    )
  };
}

function parseIntegrations(raw: unknown): Settings['integrations'] {
  if (!isObject(raw)) return { ...DEFAULT_SETTINGS.integrations };
  return {
    autoRefreshMcpUrl: pickBoolean(
      raw['autoRefreshMcpUrl'],
      DEFAULT_SETTINGS.integrations.autoRefreshMcpUrl
    ),
    allowClaudeHeadless: pickBoolean(
      raw['allowClaudeHeadless'],
      DEFAULT_SETTINGS.integrations.allowClaudeHeadless
    )
  };
}

function pickEnum(value: unknown, valid: Set<unknown>, fallback: string): string {
  return valid.has(value) ? (value as string) : fallback;
}

function pickTerminalFontSize(value: unknown): Settings['terminal']['fontSize'] {
  return VALID_TERMINAL_FONT_SIZES.has(value as number)
    ? (value as Settings['terminal']['fontSize'])
    : DEFAULT_SETTINGS.terminal.fontSize;
}

function pickDiffFontSize(value: unknown): Settings['diff']['fontSize'] {
  return VALID_DIFF_FONT_SIZES.has(value as number)
    ? (value as Settings['diff']['fontSize'])
    : DEFAULT_SETTINGS.diff.fontSize;
}

function pickPauseAutoResumeMinutes(value: unknown): Settings['browser']['pauseAutoResumeMinutes'] {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_SETTINGS.browser.pauseAutoResumeMinutes;
  }
  // Cap at 24h so a typo can't strand a tab forever.
  return Math.min(Math.round(value), 1440);
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickSessionLaunchKind(value: unknown): Settings['defaults']['newSessionKind'] {
  if (value === 'standard_terminal') return 'terminal';
  return pickEnum(
    value,
    VALID_SESSION_LAUNCH_KINDS,
    DEFAULT_SETTINGS.defaults.newSessionKind
  ) as Settings['defaults']['newSessionKind'];
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

function parseQuickLaunch(raw: unknown, defaultsSeeded: boolean): QuickLaunchPreset[] {
  if (Array.isArray(raw) && raw.length === 0 && !defaultsSeeded) {
    return clone(DEFAULT_SETTINGS.quickLaunch);
  }
  if (!Array.isArray(raw)) return clone(DEFAULT_SETTINGS.quickLaunch);
  const out: QuickLaunchPreset[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const { id, label, provider, model, dangerouslySkipPermissions } = item;
    if (typeof id !== 'string' || !id) continue;
    if (typeof label !== 'string' || !label) continue;
    if (!isAgentProvider(provider)) continue;
    const preset: QuickLaunchPreset = { id, label, provider };
    if (typeof model === 'string' && model) preset.model = model;
    if (dangerouslySkipPermissions === true) preset.dangerouslySkipPermissions = true;
    if (typeof item['extraArgs'] === 'string' && item['extraArgs']) preset.extraArgs = item['extraArgs'];
    out.push(preset);
  }
  return out;
}

function validateSettings(s: Settings): void {
  if (s.version !== 1) throw new Error(`Unsupported settings version: ${s.version}`);
  if (!VALID_THEMES.has(s.appearance.theme)) throw new Error(`Invalid theme: ${s.appearance.theme}`);
  if (!VALID_TERMINAL_FONT_SIZES.has(s.terminal.fontSize)) {
    throw new Error(`Invalid terminal.fontSize: ${s.terminal.fontSize}`);
  }
  if (typeof s.terminal.confirmDeleteTabs !== 'boolean') {
    throw new Error('Invalid terminal.confirmDeleteTabs');
  }
  if (!VALID_DIFF_FONT_SIZES.has(s.diff.fontSize)) {
    throw new Error(`Invalid diff.fontSize: ${s.diff.fontSize}`);
  }
  if (!VALID_RUN_MODES.has(s.defaults.runMode)) throw new Error(`Invalid runMode: ${s.defaults.runMode}`);
  if (!VALID_SHELLS.has(s.defaults.shell)) throw new Error(`Invalid shell: ${s.defaults.shell}`);
  if (!VALID_SESSION_LAUNCH_KINDS.has(s.defaults.newSessionKind)) {
    throw new Error(`Invalid newSessionKind: ${s.defaults.newSessionKind}`);
  }
  if (typeof s.defaults.cwd !== 'string' || !s.defaults.cwd) {
    throw new Error('defaults.cwd must be a non-empty string');
  }
  if (s.defaults.runMode === 'wsl' && s.defaults.wslDistro !== undefined && !s.defaults.wslDistro) {
    throw new Error('wslDistro must be a non-empty string when set');
  }
  if (!isObject(s.models as unknown)) {
    throw new Error('models must be an object');
  }
  for (const task of VALID_MODEL_TASKS) {
    const sel = s.models[task];
    if (sel === undefined) continue;
    if (!parseModelSelection(sel)) {
      throw new Error(`Invalid models.${task}: ${JSON.stringify(sel)}`);
    }
  }
  if (!Array.isArray(s.quickLaunch)) throw new Error('quickLaunch must be an array');
  if (typeof s.quickLaunchDefaultsSeeded !== 'boolean') {
    throw new Error('quickLaunchDefaultsSeeded must be a boolean');
  }
  for (const p of s.quickLaunch) {
    if (typeof p.id !== 'string' || !p.id) throw new Error('quickLaunch preset requires an id');
    if (typeof p.label !== 'string' || !p.label) throw new Error('quickLaunch preset requires a label');
    if (!isAgentProvider(p.provider)) throw new Error(`Invalid quickLaunch provider: ${p.provider}`);
  }
  if (!isObject(s.integrations as unknown)) throw new Error('integrations must be an object');
  if (typeof s.integrations.autoRefreshMcpUrl !== 'boolean') {
    throw new Error('integrations.autoRefreshMcpUrl must be a boolean');
  }
  if (typeof s.integrations.allowClaudeHeadless !== 'boolean') {
    throw new Error('integrations.allowClaudeHeadless must be a boolean');
  }
  if (!isObject(s.notes as unknown)) throw new Error('notes must be an object');
  if (typeof s.notes.draftsPerWorktree !== 'boolean') {
    throw new Error('notes.draftsPerWorktree must be a boolean');
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
