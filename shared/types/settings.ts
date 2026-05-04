import type { ShellKind, RunMode } from './sessions.js';

export type ThemePref = 'dark' | 'light' | 'system';
export type TerminalFontSizePref = 11 | 12 | 13 | 14;

export interface SettingsAppearance {
  theme: ThemePref;
}

export interface SettingsTerminal {
  fontSize: TerminalFontSizePref;
  confirmDeleteTabs: boolean;
}

export interface SettingsDefaults {
  runMode: RunMode;
  wslDistro?: string;
  shell: ShellKind;
  cwd: string;
}

export interface SettingsBinaries {
  claude?: string;
  codex?: string;
  git?: string;
  gh?: string;
  fd?: string;
  rg?: string;
  editor?: string;
}

export type ModelProvider = 'codex' | 'claude';

export type ModelTask = 'textGeneration' | 'gitCommitGeneration';

export interface ModelSelection {
  provider: ModelProvider;
  id: string;
}

export interface SettingsModels {
  textGeneration?: ModelSelection;
  gitCommitGeneration?: ModelSelection;
}

export interface ModelCatalogEntry {
  provider: ModelProvider;
  id: string;
  label: string;
}

// Hard-coded catalog of models we support for auto-rename / commit suggestions.
// Keep ids matching what the underlying CLI (`codex -m …`, `claude --model …`)
// accepts; adding entries here is the only step needed to expose them in UI.
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  { provider: 'codex', id: 'gpt-5-mini', label: 'gpt-5-mini' },
  { provider: 'codex', id: 'gpt-5', label: 'gpt-5' },
  { provider: 'codex', id: 'gpt-5-codex', label: 'gpt-5-codex' },
  { provider: 'claude', id: 'haiku', label: 'Claude Haiku' },
  { provider: 'claude', id: 'sonnet', label: 'Claude Sonnet' }
];

export const DEFAULT_MODEL_CODEX: ModelSelection = { provider: 'codex', id: 'gpt-5-mini' };
export const DEFAULT_MODEL_CLAUDE: ModelSelection = { provider: 'claude', id: 'haiku' };

export interface Settings {
  version: 1;
  appearance: SettingsAppearance;
  terminal: SettingsTerminal;
  defaults: SettingsDefaults;
  binaries: SettingsBinaries;
  models: SettingsModels;
}

export type SettingsUpdate = {
  appearance?: Partial<SettingsAppearance>;
  terminal?: Partial<SettingsTerminal>;
  defaults?: Partial<SettingsDefaults>;
  binaries?: Partial<SettingsBinaries>;
  models?: Partial<SettingsModels>;
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  appearance: { theme: 'dark' },
  terminal: { fontSize: 13, confirmDeleteTabs: true },
  defaults: { runMode: 'wsl', wslDistro: 'Ubuntu', shell: 'auto', cwd: '~' },
  binaries: {},
  models: {
    textGeneration: DEFAULT_MODEL_CODEX,
    gitCommitGeneration: DEFAULT_MODEL_CODEX
  }
};
