import type { DeviceDescriptor, DeviceId, SessionRef, TerminalRef } from './devices.js';
import type { Session, SessionRuntimeState } from './sessions.js';
import type {
  CheckoutRecord,
  CockpitCatalogSnapshot,
  DeviceWorkspaceSnapshot,
  LogicalProject,
  SessionMembership,
  Workspace,
  WorkspaceLocation
} from './workspaces.js';
import type {
  TerminalExitEvent,
  TerminalLocationEvent,
  TerminalInputLease,
  TerminalInputLeaseEvent,
  TerminalOutputEvent,
  TerminalReplaySnapshot,
  TerminalStatusEvent
} from './terminal.js';
import type { CockpitOperation } from './commands.js';

export type CockpitDeviceState =
  | 'connecting'
  | 'ready'
  | 'offline'
  | 'degraded'
  | 'incompatible'
  | 'provisional';

export interface CockpitPreferencesSnapshot {
  schemaVersion: 1;
  revision: number;
  cockpitId: string;
  filterDeviceIds: DeviceId[];
  defaultPlacementDeviceId: DeviceId | null;
}

export interface CockpitPreferencesUpdate {
  filterDeviceIds?: DeviceId[];
  defaultPlacementDeviceId?: DeviceId | null;
}

export interface CockpitCatalogExportManifest {
  schemaVersion: 1;
  cockpitId: string;
  exportEpoch: string;
  exportedAt: string;
  catalogSchemaVersion: number;
  catalogRevision: number;
  checksum: {
    algorithm: 'sha256';
    value: string;
  };
}

export interface CockpitCatalogExportBundle {
  manifest: CockpitCatalogExportManifest;
  catalog: CockpitCatalogSnapshot;
}

export interface CockpitCatalogImportRequest {
  bundle: CockpitCatalogExportBundle;
  expectedRevision: number;
  replace: true;
}

export interface CockpitCatalogImportResult {
  snapshot: CockpitCatalogSnapshot;
  sourceCockpitId: string;
  exportEpoch: string;
  backupPath: string;
}

export interface CockpitDeviceSummary {
  deviceId: DeviceId;
  name: string;
  state: CockpitDeviceState;
  platform?: string;
  compatibility?: 'compatible' | 'device-upgrade-required' | 'client-upgrade-required';
  capabilityRevision?: string;
  capabilities?: string[];
  lastSeenAt?: string;
  error?: string;
}

export interface CockpitSessionProjection {
  ref: SessionRef;
  key: string;
  deviceName: string;
  session: Session;
  runtime: CockpitRuntimeProjection | null;
}

export interface CockpitRuntimeProjection {
  sessionRef: SessionRef;
  terminalRef: TerminalRef | null;
  state: SessionRuntimeState;
}

export type CockpitSourceConformance = 'aligned' | 'mismatch' | 'unknown';

export interface CockpitWorkspaceSessionProjection {
  projection: CockpitSessionProjection;
  membership: SessionMembership;
  sourceConformance: CockpitSourceConformance;
}

export interface CockpitWorkspaceLocationProjection {
  location: WorkspaceLocation;
  device: CockpitDeviceSummary | null;
  checkout: CheckoutRecord | null;
  availability: 'available' | 'preparing' | 'drifted' | 'unavailable' | 'offline' | 'incompatible';
}

export interface CockpitWorkspaceProjection {
  workspace: Workspace;
  locations: CockpitWorkspaceLocationProjection[];
  sessions: CockpitWorkspaceSessionProjection[];
  danglingSessionRefs: SessionRef[];
}

export interface CockpitProjectProjection {
  project: LogicalProject;
  workspaces: CockpitWorkspaceProjection[];
}

export interface CockpitUnassignedProjection {
  device: CockpitDeviceSummary | null;
  sessions: CockpitSessionProjection[];
}

export interface CockpitNavigationProjection {
  catalogRevision: number;
  projects: CockpitProjectProjection[];
  unassigned: CockpitUnassignedProjection[];
}

export interface CockpitSnapshot {
  cockpitId: string;
  revision: number;
  capturedAt: string;
  devices: CockpitDeviceSummary[];
  sessions: CockpitSessionProjection[];
  archivedSessions: CockpitSessionProjection[];
  catalog: CockpitCatalogSnapshot | null;
  navigation: CockpitNavigationProjection | null;
  filterDeviceIds: DeviceId[];
  defaultPlacementDeviceId: DeviceId | null;
  recoverableOperations: CockpitOperation[];
}

export interface CockpitDemand {
  terminalOutput: TerminalRef[];
}

export type CockpitEvent =
  | { type: 'snapshot'; snapshot: CockpitSnapshot }
  | { type: 'device'; device: CockpitDeviceSummary }
  | { type: 'session.changed'; session: CockpitSessionProjection }
  | { type: 'session.deleted'; ref: SessionRef }
  | {
      type: 'terminal.output';
      terminalRef: TerminalRef;
      sessionRef: SessionRef;
      event: TerminalOutputEvent;
    }
  | {
      type: 'terminal.exit';
      terminalRef: TerminalRef;
      sessionRef: SessionRef;
      event: TerminalExitEvent;
    }
  | {
      type: 'terminal.status';
      terminalRef: TerminalRef | null;
      sessionRef: SessionRef;
      event: TerminalStatusEvent;
    }
  | {
      type: 'terminal.location';
      terminalRef: TerminalRef;
      sessionRef: SessionRef;
      event: TerminalLocationEvent;
    }
  | {
      type: 'terminal.input-lease';
      terminalRef: TerminalRef;
      event: TerminalInputLeaseEvent;
    }
  | { type: 'repair'; deviceId: DeviceId; reason: string };

export interface CockpitTerminalInputRequest {
  terminalRef: TerminalRef;
  data: string;
}

export interface CockpitTerminalInputLeaseRequest {
  terminalRef: TerminalRef;
  takeover?: boolean;
}

export interface CockpitTerminalInputLeaseResult {
  terminalRef: TerminalRef;
  lease: TerminalInputLease;
}

export interface CockpitTerminalResizeRequest {
  terminalRef: TerminalRef;
  cols: number;
  rows: number;
}

export interface CockpitTerminalReplayRequest {
  terminalRef: TerminalRef;
  afterSeq?: number;
}

export interface CockpitTerminalStopRequest {
  terminalRef: TerminalRef;
}

export interface CockpitTerminalReplay {
  terminalRef: TerminalRef;
  sessionRef: SessionRef | null;
  snapshot: TerminalReplaySnapshot | null;
}

export interface DeviceReadSnapshot {
  descriptor: DeviceDescriptor;
  workspace: DeviceWorkspaceSnapshot | null;
  sessions: Session[];
  archivedSessions: Session[];
  runtimes: SessionRuntimeState[];
  capturedAt: string;
}

export function sessionRefKey(ref: SessionRef): string {
  return `${ref.deviceId}/${encodeURIComponent(ref.sessionId)}`;
}

export function terminalRefKey(ref: TerminalRef): string {
  return `${ref.deviceId}/${encodeURIComponent(ref.terminalId)}`;
}
