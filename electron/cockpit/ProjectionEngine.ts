import type {
  CockpitDeviceSummary,
  CockpitNavigationProjection,
  CockpitProjectProjection,
  CockpitSessionProjection,
  CockpitSourceConformance,
  CockpitUnassignedProjection,
  CockpitWorkspaceLocationProjection,
  CockpitWorkspaceProjection
} from '@shared/types/cockpit.js';
import { sessionRefKey } from '@shared/types/cockpit.js';
import type { DeviceId } from '@shared/types/devices.js';
import type {
  CheckoutRecord,
  CockpitCatalogSnapshot,
  DeviceWorkspaceSnapshot,
  SessionMembership,
  WorkspaceLocation
} from '@shared/types/workspaces.js';

export interface ProjectionInput {
  catalog: CockpitCatalogSnapshot;
  devices: CockpitDeviceSummary[];
  sessions: CockpitSessionProjection[];
  deviceWorkspaces: ReadonlyMap<DeviceId, DeviceWorkspaceSnapshot>;
}

/** Pure join between cockpit organization and independently arriving Device facts. */
export class ProjectionEngine {
  project(input: ProjectionInput): CockpitNavigationProjection {
    const devices = new Map(input.devices.map((device) => [device.deviceId, device]));
    const sessions = new Map(input.sessions.map((session) => [session.key, session]));
    const assigned = new Set<string>();
    const memberships = groupMemberships(input.catalog.sessionMemberships);
    const locations = groupLocations(input.catalog.workspaceLocations);
    const projects: CockpitProjectProjection[] = [...input.catalog.projects]
      .filter((project) => !project.archivedAt)
      .sort(compareOrdered)
      .map((project) => ({
        project: structuredClone(project),
        workspaces: input.catalog.workspaces
          .filter((workspace) => workspace.projectId === project.id && !workspace.archivedAt)
          .sort(compareOrdered)
          .map((workspace): CockpitWorkspaceProjection => {
            const workspaceLocations = (locations.get(workspace.id) ?? [])
              .map((location) => projectLocation(location, devices, input.deviceWorkspaces));
            const workspaceMemberships = [...(memberships.get(workspace.id) ?? [])]
              .sort((left, right) => left.order - right.order || refKey(left).localeCompare(refKey(right)));
            const projectedSessions: CockpitWorkspaceProjection['sessions'] = [];
            const danglingSessionRefs: CockpitWorkspaceProjection['danglingSessionRefs'] = [];
            for (const membership of workspaceMemberships) {
              const key = refKey(membership);
              const projection = sessions.get(key);
              if (!projection) {
                danglingSessionRefs.push(structuredClone(membership.sessionRef));
                continue;
              }
              assigned.add(key);
              projectedSessions.push({
                projection: structuredClone(projection),
                membership: structuredClone(membership),
                sourceConformance: sourceConformance(projection, workspaceLocations)
              });
            }
            return {
              workspace: structuredClone(workspace),
              locations: workspaceLocations,
              sessions: projectedSessions,
              danglingSessionRefs
            };
          })
      }));
    const unassignedByDevice = new Map<DeviceId, CockpitSessionProjection[]>();
    for (const session of input.sessions) {
      if (assigned.has(session.key)) continue;
      const current = unassignedByDevice.get(session.ref.deviceId) ?? [];
      current.push(structuredClone(session));
      unassignedByDevice.set(session.ref.deviceId, current);
    }
    const unassigned: CockpitUnassignedProjection[] = [...unassignedByDevice]
      .map(([deviceId, deviceSessions]) => ({
        device: devices.has(deviceId) ? structuredClone(devices.get(deviceId)!) : null,
        sessions: deviceSessions.sort(compareSessionProjection)
      }))
      .sort((left, right) =>
        (left.device?.name ?? left.sessions[0]?.deviceName ?? '')
          .localeCompare(right.device?.name ?? right.sessions[0]?.deviceName ?? '')
      );
    return { catalogRevision: input.catalog.revision, projects, unassigned };
  }
}

function projectLocation(
  location: WorkspaceLocation,
  devices: ReadonlyMap<DeviceId, CockpitDeviceSummary>,
  workspaces: ReadonlyMap<DeviceId, DeviceWorkspaceSnapshot>
): CockpitWorkspaceLocationProjection {
  const device = devices.get(location.checkout.deviceId) ?? null;
  const checkout = workspaces.get(location.checkout.deviceId)?.checkouts.find(
    (candidate) => candidate.id === location.checkout.checkoutId
  ) ?? null;
  return {
    location: structuredClone(location),
    device: device ? structuredClone(device) : null,
    checkout: checkout ? structuredClone(checkout) : null,
    availability: locationAvailability(location, device, checkout)
  };
}

function locationAvailability(
  location: WorkspaceLocation,
  device: CockpitDeviceSummary | null,
  checkout: CheckoutRecord | null
): CockpitWorkspaceLocationProjection['availability'] {
  if (device?.state === 'incompatible') return 'incompatible';
  if (!device || device.state === 'offline' || device.state === 'connecting' || device.state === 'provisional') {
    return 'offline';
  }
  if (!checkout || checkout.lifecycle === 'missing' || checkout.lifecycle === 'cleanup-planned') {
    return 'unavailable';
  }
  if (checkout.lifecycle === 'pending' || location.state === 'preparing' || location.state === 'proposed') {
    return 'preparing';
  }
  if (location.state === 'drifted') return 'drifted';
  return location.state === 'available' ? 'available' : 'unavailable';
}

function sourceConformance(
  session: CockpitSessionProjection,
  locations: CockpitWorkspaceLocationProjection[]
): CockpitSourceConformance {
  const checkoutId = session.session.source?.checkoutId;
  if (!checkoutId) return 'unknown';
  return locations.some((location) =>
    location.location.checkout.deviceId === session.ref.deviceId
    && location.location.checkout.checkoutId === checkoutId
  ) ? 'aligned' : 'mismatch';
}

function groupMemberships(values: SessionMembership[]): Map<string, SessionMembership[]> {
  const grouped = new Map<string, SessionMembership[]>();
  for (const membership of values) {
    const current = grouped.get(membership.workspaceId) ?? [];
    current.push(membership);
    grouped.set(membership.workspaceId, current);
  }
  return grouped;
}

function groupLocations(values: WorkspaceLocation[]): Map<string, WorkspaceLocation[]> {
  const grouped = new Map<string, WorkspaceLocation[]>();
  for (const location of values) {
    const current = grouped.get(location.workspaceId) ?? [];
    current.push(location);
    grouped.set(location.workspaceId, current);
  }
  return grouped;
}

function refKey(membership: SessionMembership): string {
  return sessionRefKey(membership.sessionRef);
}

function compareOrdered(
  left: { order: number; name: string; id: string },
  right: { order: number; name: string; id: string }
): number {
  return left.order - right.order || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function compareSessionProjection(
  left: CockpitSessionProjection,
  right: CockpitSessionProjection
): number {
  return (left.session.sortIndex ?? Number.MAX_SAFE_INTEGER)
    - (right.session.sortIndex ?? Number.MAX_SAFE_INTEGER)
    || left.session.name.localeCompare(right.session.name)
    || left.key.localeCompare(right.key);
}
