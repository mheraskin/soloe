import type {
  CheckoutRef,
  DeviceId,
  RepositoryRef,
  SessionRef
} from './devices.js';
import type {
  RunMode,
  Session,
  SessionColor,
  SessionDraft,
  SessionLaunch
} from './sessions.js';
import type { CockpitOperation, CockpitPlan } from './commands.js';
import type { TerminalRef } from './devices.js';
import type { DeviceOperationReceipt } from './commands.js';
import type {
  GitCheckoutLossEvidence,
  GitRemoteEvidence,
  GitStatus
} from './git.js';

export type LogicalProjectId = string;
export type WorkspaceId = string;
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

export interface LogicalProject {
  id: LogicalProjectId;
  version: number;
  name: string;
  canonicalRepository: RepositoryIdentity | null;
  repositoryAliases: RepositoryIdentity[];
  order: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ProjectPresence {
  projectId: LogicalProjectId;
  repository: RepositoryRef;
  adoptedFromEvidence: RepositoryIdentity | null;
  linkedAt: string;
}

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

export interface Workspace {
  id: WorkspaceId;
  projectId: LogicalProjectId;
  version: number;
  name: string;
  source: WorkspaceSource;
  order: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface WorkspaceLocation {
  id: WorkspaceLocationId;
  workspaceId: WorkspaceId;
  checkout: CheckoutRef;
  desiredRole: 'ordinary';
  state: 'proposed' | 'preparing' | 'available' | 'drifted' | 'unavailable';
  version: number;
  linkedAt: string;
}

export interface SessionMembership {
  sessionRef: SessionRef;
  workspaceId: WorkspaceId;
  order: number;
  linkedAt: string;
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
  /** Preallocated by the Cockpit so an ambiguous retry cannot duplicate a Session. */
  sessionId: string;
  draft: SessionDraft;
}

export interface DeviceSessionSourceUpdateRequest {
  sessionId: string;
  expectedVersion: number;
  source: SessionSource;
}

export interface SessionPlacementDraft {
  name: string;
  launch: SessionLaunch;
  tags?: string[];
  pinned?: boolean;
  color?: SessionColor;
}

export interface CockpitPlaceSessionIntent {
  kind: 'place-session';
  workspaceId: WorkspaceId;
  targetDeviceId: DeviceId;
  sourceMode: 'shared' | 'isolated';
  session: SessionPlacementDraft;
  successorOf?: SessionRef;
}

export interface CockpitPlaceSessionPreview {
  action: 'reuse-location' | 'prepare-location' | 'prepare-isolated' | 'clone-presence';
  deviceName: string;
  sessionId: string;
  locationId: WorkspaceLocationId | null;
  checkoutId: string;
  targetPath: string;
  runMode: RunMode;
  wslDistro?: string;
  source: WorkspaceSource;
}

export type CockpitPlaceSessionPlan = CockpitPlan<
  CockpitPlaceSessionIntent,
  CockpitPlaceSessionPreview
> & {
  kind: 'place-session';
  catalogRevision: number;
  devicePlan?: DeviceWorkspacePlan;
};

export interface CockpitPlaceSessionResult {
  sessionRef: SessionRef;
  terminalRef: TerminalRef | null;
  session: Session;
  checkout: CheckoutRef;
  locationId: WorkspaceLocationId | null;
  started: boolean;
  startError?: string;
}

export type CockpitPlaceSessionOperation = CockpitOperation<CockpitPlaceSessionResult>;

export interface CockpitAlignWorkspaceIntent {
  kind: 'align-workspace';
  workspaceId: WorkspaceId;
  sourceDeviceId: DeviceId;
  targetDeviceId: DeviceId;
  remote?: string;
}

export interface CockpitAlignWorkspacePreview {
  workspaceName: string;
  branchRef: string;
  remote: string;
  sourceDeviceName: string;
  targetDeviceName: string;
  sourceOid: string;
  targetOid: string;
  remoteOid: string | null;
}

export type CockpitAlignWorkspacePlan = CockpitPlan<
  CockpitAlignWorkspaceIntent,
  CockpitAlignWorkspacePreview
> & {
  kind: 'align-workspace';
  catalogRevision: number;
  sourceDevicePlan: DeviceWorkspacePlan;
  targetDevicePlan: DeviceWorkspacePlan;
};

export interface CockpitAlignWorkspaceResult {
  sourceReceipt: DeviceOperationReceipt;
  targetReceipt: DeviceOperationReceipt;
}

export type CockpitAlignWorkspaceOperation = CockpitOperation<CockpitAlignWorkspaceResult>;

export interface CockpitSessionSourceLifecycleIntent {
  kind: 'promote-isolated-source' | 'cleanup-isolated-source';
  sessionRef: SessionRef;
}

export interface CockpitSessionSourceLifecyclePreview {
  deviceName: string;
  sessionName: string;
  checkoutId: string;
  checkoutPath: string;
  workspaceId: WorkspaceId | null;
  locationId: WorkspaceLocationId | null;
  sessionVersion: number;
}

export type CockpitSessionSourceLifecyclePlan = CockpitPlan<
  CockpitSessionSourceLifecycleIntent,
  CockpitSessionSourceLifecyclePreview
> & {
  kind: 'session-source-lifecycle';
  catalogRevision: number;
  devicePlan: DeviceWorkspacePlan;
};

export interface CockpitSessionSourceLifecycleResult {
  deviceReceipt: DeviceOperationReceipt;
  locationId: WorkspaceLocationId | null;
  session: Session | null;
}

export type CockpitSessionSourceLifecycleOperation = CockpitOperation<
  CockpitSessionSourceLifecycleResult
>;

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

export interface CockpitCatalogSnapshot {
  schemaVersion: 1;
  revision: number;
  projects: LogicalProject[];
  projectPresences: ProjectPresence[];
  workspaces: Workspace[];
  workspaceLocations: WorkspaceLocation[];
  sessionMemberships: SessionMembership[];
  migrations: CatalogMigrationRecord[];
}

export interface CatalogMigrationRecord {
  key: string;
  completedAt: string;
  projectMap: Record<string, LogicalProjectId>;
  workspaceMap: Record<string, WorkspaceId>;
}

export type CatalogMutation =
  | {
      type: 'project.create';
      project: {
        id: LogicalProjectId;
        name: string;
        canonicalRepository: RepositoryIdentity | null;
        repositoryAliases?: RepositoryIdentity[];
        order?: number;
      };
    }
  | {
      type: 'project.rename';
      projectId: LogicalProjectId;
      expectedVersion: number;
      name: string;
    }
  | {
      type: 'project.archive';
      projectId: LogicalProjectId;
      expectedVersion: number;
      archived: boolean;
    }
  | {
      type: 'project.repository';
      projectId: LogicalProjectId;
      expectedVersion: number;
      canonicalRepository: RepositoryIdentity;
      repositoryAliases?: RepositoryIdentity[];
    }
  | {
      type: 'presence.link';
      projectId: LogicalProjectId;
      repository: RepositoryRef;
      adoptedFromEvidence: RepositoryIdentity | null;
    }
  | {
      type: 'workspace.create';
      workspace: {
        id: WorkspaceId;
        projectId: LogicalProjectId;
        name: string;
        source: WorkspaceSource;
        order?: number;
      };
    }
  | {
      type: 'workspace.update';
      workspaceId: WorkspaceId;
      expectedVersion: number;
      name?: string;
      source?: WorkspaceSource;
      archived?: boolean;
    }
  | {
      type: 'location.link';
      location: {
        id: WorkspaceLocationId;
        workspaceId: WorkspaceId;
        checkout: CheckoutRef;
        state?: WorkspaceLocation['state'];
      };
    }
  | {
      type: 'location.update';
      locationId: WorkspaceLocationId;
      expectedVersion: number;
      state: WorkspaceLocation['state'];
    }
  | {
      type: 'session.regroup';
      sessionRef: SessionRef;
      workspaceId: WorkspaceId;
      order?: number;
    }
  | {
      type: 'session.unassign';
      sessionRef: SessionRef;
    }
  | {
      type: 'session.reorder';
      workspaceId: WorkspaceId;
      sessionRefs: SessionRef[];
    }
  | {
      type: 'migration.record';
      migration: CatalogMigrationRecord;
    };

export interface CatalogTransaction {
  expectedRevision: number;
  mutations: CatalogMutation[];
}

export interface CatalogTransactionResult {
  snapshot: CockpitCatalogSnapshot;
  changedEntityRefs: string[];
}
