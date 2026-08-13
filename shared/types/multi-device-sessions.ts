import type { DeviceDescriptor, DeviceId, SessionRef, TerminalRef } from './devices.js';
import type { GitWorktree } from './git.js';
import type { Project } from './projects.js';
import type { Session, SessionDraft, SessionRuntimeState } from './sessions.js';
import type { TerminalReplaySnapshot } from './terminal.js';
import type { DeviceWorkspaceSnapshot, RepositoryIdentity } from './workspaces.js';

export interface SessionDeviceSnapshot {
  descriptor: DeviceDescriptor;
  workspace: DeviceWorkspaceSnapshot | null;
  sessions: Session[];
  archivedSessions: Session[];
  runtimes: SessionRuntimeState[];
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
  capturedAt: string;
}

export interface DeviceTerminalReplay {
  terminalRef: TerminalRef | null;
  sessionRef: SessionRef | null;
  snapshot: TerminalReplaySnapshot | null;
}

export interface MultiDeviceSessionView {
  ref: SessionRef;
  key: string;
  deviceName: string;
  available: boolean;
  session: Session;
  runtime: SessionRuntimeState | null;
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
  workspaceKey: string;
  targetDeviceId: DeviceId;
  session: Pick<SessionDraft, 'name' | 'launch'>
    & Partial<Pick<SessionDraft, 'tags' | 'pinned' | 'color'>>;
}

export interface MultiDeviceSessionCreationPlan {
  planId: string;
  workspaceKey: string;
  targetDeviceId: DeviceId;
  deviceName: string;
  action: 'use-existing-location' | 'clone-project' | 'prepare-workspace-location';
  targetPath: string | null;
  executable: boolean;
  blockers: string[];
  warnings: string[];
  expiresAt: string;
}
