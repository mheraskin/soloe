import type { DeviceDescriptor, DeviceId, SessionRef, TerminalRef } from './devices.js';
import type { GitWorktree } from './git.js';
import type { Project } from './projects.js';
import type { Session, SessionDraft, SessionRuntimeState, SessionStatus } from './sessions.js';
import type { TerminalReplaySnapshot, TerminalScreenSnapshot } from './terminal.js';
import type { DeviceWorkspaceSnapshot, RepositoryIdentity } from './workspaces.js';
import type { ObservedAgentSnapshot } from './agents.js';

export interface SessionDeviceSnapshot {
  descriptor: DeviceDescriptor;
  workspace: DeviceWorkspaceSnapshot | null;
  sessions: Session[];
  archivedSessions: Session[];
  runtimes: SessionRuntimeState[];
  observations?: ObservedAgentSnapshot[];
  capturedAt: string;
}

export type DeviceAvailability =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'offline'
  | 'incompatible'
  | 'disposed';

export interface DeviceProjectInventory {
  project: Project;
  repository: RepositoryIdentity | null;
  repositoryId: string | null;
  worktrees: GitWorktree[];
}

export interface DeviceSessionInventory {
  descriptor: DeviceDescriptor;
  projects: DeviceProjectInventory[];
  sessions: Session[];
  archivedSessions: Session[];
  runtimes: SessionRuntimeState[];
  /** Optional so clients remain compatible with Devices predating observer projection. */
  observations?: ObservedAgentSnapshot[];
  capturedAt: string;
}

export interface DeviceTerminalReplay {
  terminalRef: TerminalRef | null;
  sessionRef: SessionRef | null;
  snapshot: TerminalReplaySnapshot | null;
}

export interface DeviceTerminalScreenSnapshot {
  terminalRef: TerminalRef | null;
  sessionRef: SessionRef | null;
  snapshot: TerminalScreenSnapshot | null;
}

export interface MultiDeviceSessionView {
  ref: SessionRef;
  key: string;
  deviceName: string;
  available: boolean;
  session: Session;
  /** Latest Device-published lifecycle status, independent of a live Terminal attachment. */
  lifecycleStatus?: SessionStatus;
  runtime: SessionRuntimeState | null;
  /** Last Device-published semantic state for this Session's foreground agent. */
  observation?: ObservedAgentSnapshot | null;
}

export interface WorkspaceLocationView {
  key: string;
  deviceId: DeviceId;
  deviceName: string;
  projectId: string;
  path: string;
  available: boolean;
  isMain: boolean;
}

export interface WorkspaceView {
  key: string;
  name: string;
  branch: string | null;
  locations: WorkspaceLocationView[];
  sessions: MultiDeviceSessionView[];
}

export interface ProjectView {
  key: string;
  name: string;
  repository: RepositoryIdentity | null;
  workspaces: WorkspaceView[];
}

export interface SessionDeviceView {
  deviceId: DeviceId;
  name: string;
  state: DeviceAvailability;
  available: boolean;
  local: boolean;
  platform?: DeviceDescriptor['platform'];
  error?: string;
}

export interface MultiDeviceSessionState {
  revision: number;
  capturedAt: string;
  devices: SessionDeviceView[];
  projects: ProjectView[];
  unassigned: MultiDeviceSessionView[];
  archivedSessions: MultiDeviceSessionView[];
}

export interface CreateMultiDeviceSessionRequest {
  /** Null creates an unassigned Session in a Device directory. */
  workspaceKey: string | null;
  targetDeviceId: DeviceId;
  /** Optional Device path selected from its bounded browser; defaults to the Device home. */
  targetPath?: string;
  session: Pick<SessionDraft, 'name' | 'launch'>
    & Partial<Pick<SessionDraft, 'tags' | 'pinned' | 'color'>>;
}

export interface BrowseDeviceWorkspaceDirectoriesRequest {
  deviceId: DeviceId;
  path?: string;
}

export interface MultiDeviceSessionCreationPlan {
  planId: string;
  workspaceKey: string | null;
  targetDeviceId: DeviceId;
  deviceName: string;
  action:
    | 'use-existing-location'
    | 'use-device-directory'
    | 'clone-project'
    | 'prepare-workspace-location';
  targetPath: string | null;
  executable: boolean;
  blockers: string[];
  warnings: string[];
  expiresAt: string;
}
