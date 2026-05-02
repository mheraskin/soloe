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

export interface Settings {
  version: 1;
  appearance: SettingsAppearance;
  terminal: SettingsTerminal;
  defaults: SettingsDefaults;
  binaries: SettingsBinaries;
}

export type SettingsUpdate = {
  appearance?: Partial<SettingsAppearance>;
  terminal?: Partial<SettingsTerminal>;
  defaults?: Partial<SettingsDefaults>;
  binaries?: Partial<SettingsBinaries>;
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  appearance: { theme: 'dark' },
  terminal: { fontSize: 13, confirmDeleteTabs: true },
  defaults: { runMode: 'wsl', wslDistro: 'Ubuntu', shell: 'auto', cwd: '~' },
  binaries: {}
};
