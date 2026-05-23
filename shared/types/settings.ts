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
}

export interface SettingsDiff {
  fontSize: DiffFontSizePref;
}

export interface SettingsBrowser {
  // Minutes to wait before automatically resuming a paused browser tab.
  // 0 disables auto-resume entirely (the user has to resume manually).
  pauseAutoResumeMinutes: number;
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
  provider: ModelProvider;
  id: string;
  label: string;
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

export interface SettingsNotes {
  // When true, both the untitled draft buffer AND the last-open saved note
  // are remembered per-worktree (not per-project). Switching worktrees swaps
  // the whole notes view. Default false: drafts stay per-project.
  draftsPerWorktree: boolean;
}

// Single source of truth for model selection across Settings (background
// tasks), Quick Launch presets, and the @-mention picker. Refresh by checking
// platform.claude.com/docs/en/about-claude/models/overview and
// developers.openai.com/codex/models, or by running
// `codex debug models | jq '.models[] | select(.visibility == "list" and
// .supported_in_api) | .slug'` for the live Codex slugs.
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  // Claude — current
  { provider: 'claude', id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  { provider: 'claude', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { provider: 'claude', id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  // Claude — legacy / still available
  { provider: 'claude', id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { provider: 'claude', id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  { provider: 'claude', id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
  { provider: 'claude', id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  // Claude — CLI aliases (always resolve to the latest of each tier)
  { provider: 'claude', id: 'opus', label: 'Claude Opus (latest)' },
  { provider: 'claude', id: 'sonnet', label: 'Claude Sonnet (latest)' },
  { provider: 'claude', id: 'haiku', label: 'Claude Haiku (latest)' },
  // Codex
  { provider: 'codex', id: 'gpt-5.5', label: 'GPT-5.5' },
  { provider: 'codex', id: 'gpt-5.4', label: 'GPT-5.4' },
  { provider: 'codex', id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { provider: 'codex', id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { provider: 'codex', id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  { provider: 'codex', id: 'gpt-5.2', label: 'GPT-5.2' }
];

export function modelCatalogFor(provider: ModelProvider): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((m) => m.provider === provider);
}

export const DEFAULT_MODEL_CODEX: ModelSelection = { provider: 'codex', id: 'gpt-5.4-mini' };
export const DEFAULT_MODEL_CLAUDE: ModelSelection = { provider: 'claude', id: 'haiku' };

export interface Settings {
  version: 1;
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
  notes: SettingsNotes;
}

export type SettingsUpdate = {
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
  notes?: Partial<SettingsNotes>;
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  appearance: { theme: 'dark' },
  terminal: { fontSize: 13, confirmDeleteTabs: true },
  diff: { fontSize: 13 },
  browser: { pauseAutoResumeMinutes: 5 },
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
    gitCommitGeneration: DEFAULT_MODEL_CODEX,
    worktreeOverview: DEFAULT_MODEL_CODEX
  },
  quickLaunch: DEFAULT_QUICK_LAUNCH_PRESETS,
  quickLaunchDefaultsSeeded: true,
  integrations: { autoRefreshMcpUrl: true, allowClaudeHeadless: false },
  notes: { draftsPerWorktree: false }
};
