import type { ShellKind, RunMode, SessionLaunchKind } from './sessions.js';

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
  newSessionKind: SessionLaunchKind;
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

// Catalog mirrors the visible/api-supported entries from `codex debug models`
// plus the claude aliases we use. Codex models change over time — refresh by
// running `codex debug models | jq '.models[] | select(.visibility == "list"
// and .supported_in_api) | .slug'` and reconciling.
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  { provider: 'codex', id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { provider: 'codex', id: 'gpt-5.4', label: 'GPT-5.4' },
  { provider: 'codex', id: 'gpt-5.5', label: 'GPT-5.5' },
  { provider: 'codex', id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { provider: 'claude', id: 'haiku', label: 'Claude Haiku' },
  { provider: 'claude', id: 'sonnet', label: 'Claude Sonnet' }
];

export const DEFAULT_MODEL_CODEX: ModelSelection = { provider: 'codex', id: 'gpt-5.4-mini' };
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
  defaults: {
    runMode: 'wsl',
    wslDistro: 'Ubuntu',
    shell: 'auto',
    cwd: '~',
    newSessionKind: 'terminal'
  },
  binaries: {},
  models: {
    textGeneration: DEFAULT_MODEL_CODEX,
    gitCommitGeneration: DEFAULT_MODEL_CODEX
  }
};
