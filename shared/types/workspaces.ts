import type { DeviceId } from './devices.js';
import type {
  RunMode,
  SessionDraft
} from './sessions.js';
import type { DeviceOperationReceipt } from './commands.js';
import type {
  GitCheckoutLossEvidence,
  GitRemoteEvidence,
  GitStatus
} from './git.js';

export type WorkspaceLocationId = string;

export type RepositoryIdentity =
  | {
      kind: 'unpublished';
      localIdentityId: string;
    }
  | {
      kind: 'git';
      canonicalUrl: string;
      provider?: 'github';
      providerRepositoryId?: string;
    };

export interface BranchWorkspaceSource {
  kind: 'branch';
  localRef: string;
  upstream?: {
    repository: RepositoryIdentity;
    ref: string;
  };
  lastResolved?: ResolvedSourceEvidence;
}

export interface PullRequestWorkspaceSource {
  kind: 'pull_request';
  provider: 'github';
  repository: RepositoryIdentity;
  providerPullRequestId: string;
  number: number;
  head: { repository: RepositoryIdentity; ref: string };
  base: { repository: RepositoryIdentity; ref: string };
  lastResolved?: ResolvedSourceEvidence;
}

export interface RevisionWorkspaceSource {
  kind: 'revision';
  repository?: RepositoryIdentity;
  oid: string;
  label?: string;
}

export type WorkspaceSource =
  | BranchWorkspaceSource
  | PullRequestWorkspaceSource
  | RevisionWorkspaceSource;

export interface ResolvedSourceEvidence {
  oid: string;
  observedAt: string;
  repository?: RepositoryIdentity;
}

export type SessionSource =
  | {
      kind: 'workspace-location';
      checkoutId: string;
      locationCorrelation?: WorkspaceLocationId;
    }
  | {
      kind: 'isolated-worktree';
      checkoutId: string;
      base: { oid: string; ref?: string };
      generatedBranch?: string;
      ownership: 'session';
    }
  | {
      kind: 'existing-checkout';
      checkoutId: string;
      adopted: boolean;
    };

export interface RepositoryRecord {
  id: string;
  version: number;
  identity: RepositoryIdentity | null;
  legacyProjectId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CheckoutRecord {
  id: string;
  repositoryId: string;
  path: string;
  runMode: RunMode;
  wslDistro?: string;
  role: 'main' | 'workspace' | 'isolated-session' | 'external';
  ownerSessionId?: string;
  lifecycle: 'pending' | 'ready' | 'missing' | 'cleanup-planned' | 'removed';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceWorkspaceSnapshot {
  schemaVersion: 1;
  revision: number;
  deviceId: DeviceId;
  repositories: RepositoryRecord[];
  checkouts: CheckoutRecord[];
}

export interface DeviceSessionSourceBinding {
  sessionId: string;
  source: SessionSource;
}

export interface DevicePlacedSessionRequest {
  /** Preallocated by the client so an ambiguous retry cannot duplicate a Session. */
  sessionId: string;
  draft: SessionDraft;
}

export interface DeviceSessionSourceUpdateRequest {
  sessionId: string;
  expectedVersion: number;
  source: SessionSource;
}

export interface DeviceWorkspaceLegacyMigrationRequest {
  migrationKey: string;
  projects: import('./projects.js').Project[];
  sessions: import('./sessions.js').Session[];
}

export type DeviceWorkspaceLegacyReconcileRequest = Omit<
  DeviceWorkspaceLegacyMigrationRequest,
  'migrationKey'
>;

export interface DeviceWorkspaceLegacyMigrationResult {
  snapshot: DeviceWorkspaceSnapshot;
  projectRepositories: Record<string, string>;
  sessionSources: DeviceSessionSourceBinding[];
}

export interface DeviceCheckoutRegistrationRequest {
  expectedRevision: number;
  checkout: Omit<CheckoutRecord, 'version' | 'createdAt' | 'updatedAt'>;
}

export interface DeviceCheckoutUpdateRequest {
  expectedRevision: number;
  checkoutId: string;
  expectedVersion: number;
  lifecycle?: CheckoutRecord['lifecycle'];
  role?: CheckoutRecord['role'];
  ownerSessionId?: string | null;
}

export interface DeviceRepositoryRegistrationRequest {
  expectedRevision: number;
  repository: Omit<RepositoryRecord, 'version' | 'createdAt' | 'updatedAt'>;
  mainCheckout: Omit<CheckoutRecord, 'version' | 'createdAt' | 'updatedAt'>;
}

export interface CheckoutEvidence {
  deviceId: DeviceId;
  checkoutId: string;
  generation: number;
  observedAt: string;
  headOid: string | null;
  branchRef: string | null;
  detached: boolean;
  worktree: {
    staged: number;
    unstaged: number;
    untracked: number;
    dirty: boolean;
    ignoredLossScan: 'not-run' | 'clear' | 'present';
  };
}

export interface CheckoutLossBlocker {
  code:
    | 'not-found'
    | 'lifecycle'
    | 'main'
    | 'role'
    | 'ownership'
    | 'uncertain'
    | 'staged'
    | 'unstaged'
    | 'untracked'
    | 'ignored'
    | 'unpublished'
    | 'consumer'
    | 'branch'
    | 'operation';
  message: string;
}

export interface CheckoutLossReport {
  checkoutId: string;
  checkoutVersion: number;
  observedAt: string;
  eligible: boolean;
  blockers: CheckoutLossBlocker[];
  activeConsumerSessionIds: string[];
  activeOperationIds: string[];
  evidence: GitCheckoutLossEvidence;
}

export interface PrepareWorkspaceLocationIntent {
  kind: 'prepare-workspace-location';
  repositoryId: string;
  checkoutId: string;
  /** Omit to let the Device allocate a path inside its configured managed root. */
  path?: string;
  runMode: RunMode;
  wslDistro?: string;
  source: WorkspaceSource;
}

export interface PrepareIsolatedSessionSourceIntent {
  kind: 'prepare-isolated-session-source';
  repositoryId: string;
  checkoutId: string;
  ownerSessionId: string;
  path?: string;
  runMode: RunMode;
  wslDistro?: string;
  baseOid: string;
  branchRef?: string;
  detached: boolean;
}

export interface CloneProjectPresenceIntent {
  kind: 'clone-project-presence';
  repositoryId: string;
  checkoutId: string;
  sourceUrl: string;
  path?: string;
  runMode: RunMode;
  wslDistro?: string;
  branchRef?: string;
  identity: RepositoryIdentity;
}

export interface CleanupIsolatedCheckoutIntent {
  kind: 'cleanup-isolated-checkout';
  checkoutId: string;
  expectedOwnerSessionId: string;
}

export interface PromoteIsolatedCheckoutIntent {
  kind: 'promote-isolated-checkout';
  checkoutId: string;
  expectedOwnerSessionId: string;
}

export interface PushWorkspaceBranchIntent {
  kind: 'push-workspace-branch';
  checkoutId: string;
  remote: string;
  branchRef: string;
  expectedLocalOid?: string;
  expectedRemoteOid?: string | null;
}

export interface FetchFastForwardWorkspaceBranchIntent {
  kind: 'fetch-fast-forward-workspace-branch';
  checkoutId: string;
  remote: string;
  branchRef: string;
  targetOid: string;
  expectedHeadOid?: string;
  expectedRemoteOid?: string;
}

export interface PublishNewRemoteBranchIntent {
  kind: 'publish-new-remote-branch';
  checkoutId: string;
  remote: string;
  remoteUrl: string;
  branchRef: string;
  expectedLocalOid?: string;
}

export type DeviceWorkspaceIntent =
  | PrepareWorkspaceLocationIntent
  | PrepareIsolatedSessionSourceIntent
  | CloneProjectPresenceIntent
  | CleanupIsolatedCheckoutIntent
  | PromoteIsolatedCheckoutIntent
  | PushWorkspaceBranchIntent
  | FetchFastForwardWorkspaceBranchIntent
  | PublishNewRemoteBranchIntent;

export interface DeviceWorkspacePlan {
  schemaVersion: 1;
  planId: string;
  planToken: string;
  targetDeviceId: DeviceId;
  capabilityRevision: string;
  expectedWorkspaceRevision: number;
  expectedCheckoutVersion?: number;
  intent: DeviceWorkspaceIntent;
  executable: boolean;
  blockers: string[];
  warnings: string[];
  preview: {
    repositoryPath: string | null;
    targetPath: string;
    sourceLabel: string;
    existingBranchCheckoutPath?: string;
  };
  lossReport?: CheckoutLossReport;
  remoteEvidence?: GitRemoteEvidence;
  revisionRelation?: import('./git.js').GitRevisionRelation;
  createdAt: string;
  expiresAt: string;
}

export interface PreparedWorkspaceLocationResult {
  checkout: CheckoutRecord;
  workspaceRevision: number;
}

export interface ClonedProjectPresenceResult {
  repository: RepositoryRecord;
  checkout: CheckoutRecord;
  workspaceRevision: number;
}

export interface CheckoutLifecycleResult {
  checkout: CheckoutRecord;
  workspaceRevision: number;
}

export interface PushedWorkspaceBranchResult {
  checkout: CheckoutRecord;
  evidence: GitRemoteEvidence;
  workspaceRevision: number;
}

export interface FastForwardedWorkspaceBranchResult {
  checkout: CheckoutRecord;
  evidence: GitRemoteEvidence;
  status: GitStatus;
  workspaceRevision: number;
}

export type DeviceWorkspaceOperationReceipt = DeviceOperationReceipt<
  | PreparedWorkspaceLocationResult
  | ClonedProjectPresenceResult
  | CheckoutLifecycleResult
  | PushedWorkspaceBranchResult
  | FastForwardedWorkspaceBranchResult
>;
