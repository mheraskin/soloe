import type { AgentRuntimeProvider, RunMode } from './sessions.js';

export type OverviewProvider = AgentRuntimeProvider;

export interface SessionTranscriptTurn {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  toolName?: string;
  timestamp?: string;
}

export interface SessionTranscript {
  provider: OverviewProvider;
  sessionFile: string;
  sessionId: string;
  cwd: string;
  startedAt?: string;
  endedAt?: string;
  turnCount: number;
  turns: SessionTranscriptTurn[];
  hasCompaction: boolean;
  watermark: TranscriptWatermark;
  // User-visible tab name for the corresponding session in the renderer.
  // Only set when the overview is scoped to open sessions — historical
  // scans don't have a tab to read a name from.
  displayName?: string;
}

export interface TranscriptWatermark {
  mtimeMs: number;
  size: number;
  lastRecordKey: string;
}

export interface WorktreeSessionRef {
  provider: OverviewProvider;
  sessionFile: string;
  sessionId: string;
  startedAt?: string;
  endedAt?: string;
  watermark: TranscriptWatermark;
  // Set when the renderer hands us a scoped list with tab names; left
  // undefined for historical scans where no open tab is associated.
  displayName?: string;
}

export interface OverviewSessionInput {
  transcriptPath: string;
  name: string;
}

export interface WorktreeFacts {
  cwd: string;
  branch: string | null;
  head: string | null;
  baseBranch: string | null;
  commitsAhead: number;
  commitsBehind: number;
  commitsAheadShas: string[];
  pushedAhead: boolean;
  mergedIntoBase: boolean;
  dirtyFiles: WorktreeDirtyFile[];
  dirtyHash: string;
  workingDiff: string;
  recentCommits: WorktreeRecentCommit[];
}

export interface WorktreeDirtyFile {
  path: string;
  status: 'staged' | 'unstaged' | 'untracked';
  kind: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | '?';
}

export interface WorktreeRecentCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorDate: string;
  pushed: boolean;
  mergedIntoBase: boolean;
}

export type OverviewStatus = 'fresh' | 'cached' | 'stale' | 'missing';

export interface OverviewWatermark {
  perSession: { sessionFile: string; lastRecordKey: string }[];
  headSha: string | null;
  dirtyHash: string;
}

export interface WorktreeOverview {
  worktreeCwd: string;
  status: OverviewStatus;
  text: string | null;
  generatedAt: string | null;
  generatedBy: { provider: OverviewProvider; model: string } | null;
  watermark: OverviewWatermark | null;
  sources: OverviewSourcesSummary;
  facts: WorktreeFacts;
  errorMessage?: string;
}

export interface OverviewSourcesSummary {
  sessionCount: number;
  totalTurns: number;
  providers: OverviewProvider[];
  approxInputTokens: number;
}

export interface GetOverviewRequest {
  worktreeCwd: string;
  runMode?: RunMode;
  wslDistro?: string;
  baseBranch?: string;
  // The sessions currently open in this worktree, as the renderer sees
  // them: transcriptPath in renderer form (posix in WSL mode, native in
  // Windows mode) plus the user-visible tab name. When provided the
  // overview is scoped to just these files instead of every historical
  // transcript that ever ran in this cwd; the tab name lets the model
  // organize the overview around the user's view of the sessions.
  sessions?: OverviewSessionInput[];
}

export interface RegenerateOverviewRequest extends GetOverviewRequest {}

export interface AskFollowUpRequest {
  worktreeCwd: string;
  runMode?: RunMode;
  wslDistro?: string;
  baseBranch?: string;
  sessions?: OverviewSessionInput[];
  message: string;
  history: ChatMessage[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskFollowUpChunk {
  requestId: string;
  type: 'delta' | 'done' | 'error';
  text?: string;
  error?: string;
}
