import type { ShellKind, RunMode, SessionLaunchKind, AgentRuntimeProvider } from './sessions.js';

export type ThemePref = 'dark' | 'light' | 'system';
export type TerminalFontSizePref = 11 | 12 | 13 | 14;
export type DiffFontSizePref = 11 | 12 | 13 | 14 | 15 | 16;

export interface SettingsAppearance {
  theme: ThemePref;
}

export interface SettingsTerminal {
  fontSize: TerminalFontSizePref;
  confirmDeleteTabs: boolean;
  // Retained in the settings schema for compatibility. Terminal history is
  // complete by default and clients no longer expose a truncation control.
  keepFullHistory: boolean;
}

export interface SettingsDiff {
  fontSize: DiffFontSizePref;
}

export interface SettingsBrowser {
  // Maximum number of browser tabs allowed to retain live Chromium webviews.
  // The active tab always occupies one slot; older background tabs suspend.
  maxResidentTabs: number;
  // Minutes to wait before automatically resuming a paused browser tab.
  // 0 disables auto-resume entirely (the user has to resume manually).
  pauseAutoResumeMinutes: number;
  // Show the browser toolbar control and guest-page listeners for source inspection.
  elementSourceInspectorEnabled: boolean;
}

export type BackendPlacement = 'windows' | 'linux' | 'macos' | 'wsl';

export interface SettingsBackend {
  // The Application Server and Environment Runtime always move together.
  placement: BackendPlacement;
  // Used only when placement is "wsl".
  wslDistro: string;
  // Absolute Linux path to this repository in the selected distribution.
  // Keeping a separate WSL checkout avoids sharing platform-specific
  // node_modules with the Windows checkout.
  wslRepositoryRoot: string;
}

export interface SettingsStartup {
  launchSoloeClient: boolean;
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
  cursor?: string;
  opencode?: string;
  grok?: string;
  git?: string;
  gh?: string;
  fd?: string;
  rg?: string;
  editor?: string;
}

export type ModelProvider = 'codex' | 'claude' | 'cursor';
export type ModelCatalogProvider = ModelProvider | 'opencode' | 'grok_build';

export type ModelTask = 'textGeneration' | 'gitCommitGeneration' | 'worktreeOverview';

export interface ModelSelection {
  provider: ModelProvider;
  id: string;
}

export interface SettingsModels {
  textGeneration?: ModelSelection;
  gitCommitGeneration?: ModelSelection;
  worktreeOverview?: ModelSelection;
}

export interface ModelCatalogEntry {
  provider: ModelCatalogProvider;
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface QuickLaunchPreset {
  id: string;
  label: string;
  provider: AgentRuntimeProvider;
  model?: string;
  dangerouslySkipPermissions?: boolean;
  extraArgs?: string;
}

export const DEFAULT_QUICK_LAUNCH_PRESETS: QuickLaunchPreset[] = [
  {
    id: 'claude-skip-permissions',
    label: 'Claude danger',
    provider: 'claude_code',
    dangerouslySkipPermissions: true
  },
  {
    id: 'claude-bypass-permissions',
    label: 'Claude bypass',
    provider: 'claude_code',
    extraArgs: '--permission-mode bypassPermissions'
  },
  {
    id: 'codex-yolo',
    label: 'Codex YOLO',
    provider: 'codex',
    extraArgs: '--dangerously-bypass-approvals-and-sandbox'
  },
  {
    id: 'cursor-force',
    label: 'Cursor force',
    provider: 'cursor',
    extraArgs: '--force --approve-mcps'
  }
];

export interface SettingsIntegrations {
  autoRefreshMcpUrl: boolean;
  // Opt-in for Soloe-dispatched tasks that spawn `claude -p` (worktree
  // overview, background summarization, etc). Off by default because
  // headless Claude usage may bill differently than the interactive
  // subscription. When false, Claude is hidden from background-task
  // model pickers and the service refuses to spawn it.
  allowClaudeHeadless: boolean;
}

export interface SettingsDebug {
  // Enables the separate Session event timeline. The window reads existing
  // observer history and then records renderer-visible Session state events.
  sessionEvents: boolean;
}

export interface SettingsNotes {
  // When true, both the untitled draft buffer AND the last-open saved note
  // are remembered per-worktree (not per-project). Switching worktrees swaps
  // the whole notes view. Default false: drafts stay per-project.
  draftsPerWorktree: boolean;
}

export type ShiftNumberNavigationTarget = 'worktree' | 'project';

export interface SettingsShortcuts {
  // Cmd/Ctrl+Shift+1..9 follows the visible order of either the current
  // project's worktrees or all projects in the sidebar.
  shiftNumberNavigation: ShiftNumberNavigationTarget;
  // Toggles the browser's component inspector when the browser rail is active.
  elementSourceInspector: string[];
}

export interface Settings {
  version: 2;
  backend: SettingsBackend;
  startup: SettingsStartup;
  appearance: SettingsAppearance;
  terminal: SettingsTerminal;
  diff: SettingsDiff;
  browser: SettingsBrowser;
  defaults: SettingsDefaults;
  binaries: SettingsBinaries;
  models: SettingsModels;
  quickLaunch: QuickLaunchPreset[];
  quickLaunchDefaultsSeeded: boolean;
  integrations: SettingsIntegrations;
  debug: SettingsDebug;
  notes: SettingsNotes;
  shortcuts: SettingsShortcuts;
}

export type SettingsUpdate = {
  backend?: Partial<SettingsBackend>;
  startup?: Partial<SettingsStartup>;
  appearance?: Partial<SettingsAppearance>;
  terminal?: Partial<SettingsTerminal>;
  diff?: Partial<SettingsDiff>;
  browser?: Partial<SettingsBrowser>;
  defaults?: Partial<SettingsDefaults>;
  binaries?: Partial<SettingsBinaries>;
  models?: Partial<SettingsModels>;
  quickLaunch?: QuickLaunchPreset[];
  quickLaunchDefaultsSeeded?: boolean;
  integrations?: Partial<SettingsIntegrations>;
  debug?: Partial<SettingsDebug>;
  notes?: Partial<SettingsNotes>;
  shortcuts?: Partial<SettingsShortcuts>;
};

export const DEFAULT_SETTINGS: Settings = {
  version: 2,
  backend: {
    placement: 'windows',
    wslDistro: 'Ubuntu',
    wslRepositoryRoot: ''
  },
  startup: { launchSoloeClient: false },
  appearance: { theme: 'system' },
  terminal: { fontSize: 13, confirmDeleteTabs: true, keepFullHistory: true },
  diff: { fontSize: 13 },
  browser: {
    maxResidentTabs: 2,
    pauseAutoResumeMinutes: 30,
    elementSourceInspectorEnabled: true
  },
  defaults: {
    runMode: 'wsl',
    wslDistro: 'Ubuntu',
    shell: 'auto',
    cwd: '~',
    newSessionKind: 'terminal'
  },
  binaries: {},
  models: {},
  quickLaunch: DEFAULT_QUICK_LAUNCH_PRESETS,
  quickLaunchDefaultsSeeded: true,
  integrations: { autoRefreshMcpUrl: true, allowClaudeHeadless: false },
  debug: { sessionEvents: false },
  notes: { draftsPerWorktree: false },
  shortcuts: {
    shiftNumberNavigation: 'worktree',
    elementSourceInspector: ['Ctrl', 'Alt', 'Shift', 'S']
  }
};

export function defaultSettingsForRunMode(runMode: Exclude<RunMode, 'wsl'> | 'wsl'): Settings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.defaults.runMode = runMode;
  if (runMode !== 'wsl') delete settings.defaults.wslDistro;
  if (runMode === 'linux' || runMode === 'macos') settings.backend.placement = runMode;
  return settings;
}
