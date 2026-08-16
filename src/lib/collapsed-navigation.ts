import type {
  MultiDeviceSessionState,
  MultiDeviceSessionView,
  ProjectView,
  WorkspaceLocationView,
  WorkspaceView
} from '@shared/types/multi-device-sessions.js';

export interface ProjectedCollapsedNavigation {
  selected: MultiDeviceSessionView;
  project: ProjectView | null;
  workspace: WorkspaceView | null;
  projects: Array<{ project: ProjectView; sessionCount: number }>;
  workspaces: Array<{
    workspace: WorkspaceView;
    location: WorkspaceLocationView | null;
    selectedSessionKey: string | null;
  }>;
  sessions: MultiDeviceSessionView[];
}

export function projectedCollapsedNavigation(
  state: MultiDeviceSessionState,
  selectedSessionKey: string | null
): ProjectedCollapsedNavigation | null {
  const remoteDeviceIds = new Set(
    state.devices.filter((device) => !device.local).map((device) => device.deviceId)
  );
  const effectiveSessionKey = selectedSessionKey
    ?? state.projects.flatMap((project) => project.workspaces)
      .flatMap((workspace) => workspace.sessions)
      .find((session) => session.available && remoteDeviceIds.has(session.ref.deviceId))?.key
    ?? state.unassigned.find((session) =>
      session.available && remoteDeviceIds.has(session.ref.deviceId)
    )?.key
    ?? null;
  if (!effectiveSessionKey) return null;
  for (const project of state.projects) {
    for (const workspace of project.workspaces) {
      const selected = workspace.sessions.find((session) => session.key === effectiveSessionKey);
      if (!selected) continue;
      return {
        selected,
        project,
        workspace,
        projects: state.projects.map((candidate) => ({
          project: candidate,
          sessionCount: candidate.workspaces.reduce(
            (total, candidateWorkspace) => total + candidateWorkspace.sessions.length,
            0
          )
        })),
        workspaces: project.workspaces.map((candidate) => ({
          workspace: candidate,
          location: locationForDevice(candidate, selected.ref.deviceId),
          selectedSessionKey: candidate.sessions.find((session) =>
            session.ref.deviceId === selected.ref.deviceId && session.available
          )?.key ?? candidate.sessions.find((session) => session.available)?.key ?? null
        })),
        sessions: [...workspace.sessions]
      };
    }
  }
  const selected = state.unassigned.find((session) => session.key === effectiveSessionKey);
  if (!selected) return null;
  return {
    selected,
    project: null,
    workspace: null,
    projects: state.projects.map((project) => ({
      project,
      sessionCount: project.workspaces.reduce(
        (total, workspace) => total + workspace.sessions.length,
        0
      )
    })),
    workspaces: [],
    sessions: state.unassigned.filter((session) => session.ref.deviceId === selected.ref.deviceId)
  };
}

function locationForDevice(
  workspace: WorkspaceView,
  deviceId: string
): WorkspaceLocationView | null {
  return workspace.locations.find((location) => location.deviceId === deviceId)
    ?? workspace.locations.find((location) => location.available)
    ?? workspace.locations[0]
    ?? null;
}
