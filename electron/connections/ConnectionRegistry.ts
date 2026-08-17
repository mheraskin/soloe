import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ConnectionId,
  ConnectionPreferencesUpdate,
  ConnectionSelectionResult,
  ConnectionSnapshot,
  MachineConnection,
  MachineConnectionSource,
  MachineConnectionTrust,
  TailscaleConnectionInfo
} from '@shared/types/connections.js';
import {
  DEFAULT_TAILSCALE_HTTPS_PORT,
  LEGACY_TAILSCALE_HTTPS_PORT
} from '@soloe/domain';
import {
  isDeviceId,
  negotiateDeviceProtocol,
  parseDeviceDescriptor,
  type DeviceDescriptor,
  type DeviceId,
  type DeviceProtocolCompatibility,
  type DeviceProtocolRange
} from '@shared/types/devices.js';
import type { TailscaleDiscoveryResult } from './TailscaleDiscovery.js';

const MAX_CONNECTIONS = 64;
const MAX_ENABLED_CONNECTIONS = 10;
const MAX_ENDPOINT_ALIASES = 8;
const REQUIRED_MULTI_DEVICE_CAPABILITIES = [
  'device.describe.v1',
  'device.snapshot.v1',
  'events.envelope.v1',
  'sessions.multi-device.v1',
  'runtime.sessions.v1',
  'runtime.terminal-input-lease.v1',
  'runtime.terminal-replay.v1',
  'workspace-device.v1',
  'workspace-placement-plan.v1'
] as const;

interface PersistedMachineV1 {
  id: ConnectionId;
  name: string;
  endpoint: string;
  source: Exclude<MachineConnectionSource, 'local'>;
  os?: string;
  lastSeenAt?: string;
}

interface PersistedMachineV2 extends PersistedMachineV1 {
  endpointAliases: string[];
  trust: Exclude<MachineConnectionTrust, 'local'>;
  enabled?: boolean;
  deviceId?: DeviceId;
  observedDeviceId?: DeviceId;
  protocol?: DeviceProtocolRange;
  capabilityRevision?: string;
  capabilities?: string[];
  serverEpoch?: string;
  updateRequired?: boolean;
}

interface PersistedConnectionsV1 {
  version: 1;
  activeId: ConnectionId;
  machines: PersistedMachineV1[];
}

interface PersistedConnectionsV2 {
  version: 2;
  activeId: ConnectionId;
  machines: PersistedMachineV2[];
}

interface PersistedConnectionsV3 {
  version: 3;
  activeId: ConnectionId;
  preferences: {
    tailscaleEnabled: boolean;
    tailscaleHttpsPort: number;
  };
  machines: PersistedMachineV2[];
}

type ParsedConnections = PersistedConnectionsV1 | PersistedConnectionsV2 | PersistedConnectionsV3;

export interface ConnectionRegistryOptions {
  filePath: string;
  localName: string;
  discover: (tailscaleHttpsPort: number) => Promise<TailscaleDiscoveryResult>;
  probe: (endpoint: string) => Promise<boolean>;
  describe?: (endpoint: string) => Promise<{
    descriptor: DeviceDescriptor;
    compatibility: DeviceProtocolCompatibility;
  }>;
  now?: () => Date;
  tailscaleHttpsPort?: number;
}

const EMPTY_TAILSCALE: TailscaleConnectionInfo = {
  state: 'unavailable',
  tailnet: null,
  selfDnsName: null,
  message: 'Refresh to discover Soloe machines on this tailnet.',
  sharing: {
    state: 'unavailable',
    message: 'Install Tailscale to connect this Soloe Device to other machines.',
    setupUrl: 'https://tailscale.com/download'
  }
};

const DISABLED_TAILSCALE: TailscaleConnectionInfo = {
  state: 'disabled',
  tailnet: null,
  selfDnsName: null,
  message: 'Tailscale connections are turned off in Settings.',
  sharing: {
    state: 'unavailable',
    message: 'Enable Tailscale connections to discover other Soloe devices.',
    setupUrl: null
  }
};

export class ConnectionRegistry {
  private activeId: ConnectionId = 'local';
  private machines = new Map<ConnectionId, MachineConnection>();
  private tailscale: TailscaleConnectionInfo = { ...EMPTY_TAILSCALE };
  private refreshedAt: string | null = null;
  private listeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private refreshPromise: Promise<ConnectionSnapshot> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private readonly now: () => Date;
  private tailscaleEnabled = true;
  private tailscaleHttpsPort: number;

  constructor(private readonly options: ConnectionRegistryOptions) {
    this.now = options.now ?? (() => new Date());
    this.tailscaleHttpsPort = validTailscalePort(
      options.tailscaleHttpsPort
        ?? numericEnvironmentPort(process.env.SOLOE_TAILSCALE_SERVE_PORT)
        ?? DEFAULT_TAILSCALE_HTTPS_PORT
    );
    this.resetLocalMachine();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    let parsed: ParsedConnections | null = null;
    let source = '';
    try {
      source = await fs.readFile(this.options.filePath, 'utf8');
      parsed = parsePersisted(JSON.parse(source));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[connections] ignored unreadable connection registry', error);
      }
    }
    if (!parsed) return;
    this.activeId = parsed.activeId;
    if (parsed.version === 3) {
      this.tailscaleEnabled = parsed.preferences.tailscaleEnabled;
      this.tailscaleHttpsPort = validTailscalePort(parsed.preferences.tailscaleHttpsPort);
      if (!this.tailscaleEnabled) this.tailscale = { ...DISABLED_TAILSCALE };
    }
    for (const persisted of parsed.machines) {
      const machine = persistedMachineProjection(persisted, this.activeId);
      this.machines.set(machine.id, machine);
    }
    if (this.activeId !== 'local' && !this.machines.has(this.activeId)) {
      this.activeId = 'local';
    }
    this.applyActiveState();
    if (parsed.version !== 3) {
      await this.backupV1AndPersist(source);
    }
  }

  async get(): Promise<ConnectionSnapshot> {
    await this.init();
    return this.snapshot();
  }

  activeEndpoint(): string | null {
    if (this.activeId === 'local') return null;
    return this.machines.get(this.activeId)?.endpoint ?? null;
  }

  refresh(): Promise<ConnectionSnapshot> {
    this.refreshPromise ??= this.refreshNow().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async configureTailscale(
    patch: ConnectionPreferencesUpdate
  ): Promise<ConnectionSnapshot> {
    await this.init();
    if (patch.tailscaleEnabled !== undefined) {
      this.tailscaleEnabled = patch.tailscaleEnabled;
    }
    if (patch.tailscaleHttpsPort !== undefined) {
      this.tailscaleHttpsPort = validTailscalePort(patch.tailscaleHttpsPort);
    }
    if (!this.tailscaleEnabled) {
      this.tailscale = { ...DISABLED_TAILSCALE, sharing: { ...DISABLED_TAILSCALE.sharing } };
      for (const [id, machine] of this.machines) {
        if (id !== 'local') this.machines.set(id, { ...machine, status: 'unavailable' });
      }
    }
    await this.persist();
    this.publish();
    return this.refresh();
  }

  async add(rawEndpoint: string): Promise<ConnectionSnapshot> {
    await this.init();
    const endpoint = normalizeSoloeEndpoint(rawEndpoint);
    const existingEntry = this.findByEndpoint(endpoint);
    const id = existingEntry?.[0] ?? connectionIdForEndpoint(endpoint);
    const existing = existingEntry?.[1];
    const available = await this.options.probe(endpoint);
    const seenAt = available ? this.now().toISOString() : existing?.lastSeenAt;
    this.machines.set(id, {
      ...(existing ?? provisionalMachine(id, endpoint, displayNameForEndpoint(endpoint))),
      id,
      name: existing?.name ?? displayNameForEndpoint(endpoint),
      endpoint,
      endpointAliases: mergeAliases(existing?.endpointAliases ?? [], [endpoint]),
      source: 'manual',
      status: available ? 'available' : 'unavailable',
      active: id === this.activeId,
      isSelf: false,
      ...(seenAt ? { lastSeenAt: seenAt } : {})
    });
    await this.persist();
    if (available && this.options.describe) {
      try {
        const described = await this.options.describe(endpoint);
        return await this.bindDescriptor(
          endpoint,
          described.descriptor,
          described.compatibility
        );
      } catch (error) {
        if (error instanceof ConnectionIdentityMismatchError) throw error;
        // Legacy or temporarily unauthorized servers remain provisional.
      }
    }
    return this.publish();
  }

  async bindDescriptor(
    rawEndpoint: string,
    input: DeviceDescriptor,
    compatibility?: DeviceProtocolCompatibility
  ): Promise<ConnectionSnapshot> {
    await this.init();
    const endpoint = normalizeSoloeEndpoint(rawEndpoint);
    const descriptor = parseDeviceDescriptor(input);
    const negotiated = compatibility ?? negotiateDeviceProtocol(descriptor.protocol);
    let entry = this.findByEndpoint(endpoint);
    if (!entry) {
      const id = connectionIdForEndpoint(endpoint);
      const machine = provisionalMachine(id, endpoint, displayNameForEndpoint(endpoint));
      this.machines.set(id, machine);
      entry = [id, machine];
    }
    let [currentId, current] = entry;
    if (current.deviceId && current.deviceId !== descriptor.deviceId) {
      if (current.source === 'discovered') {
        this.machines.delete(currentId);
        if (this.activeId === currentId) this.activeId = 'local';
        currentId = connectionIdForEndpoint(endpoint);
        current = provisionalMachine(
          currentId,
          endpoint,
          displayNameForEndpoint(endpoint)
        );
        this.machines.set(currentId, current);
        this.applyActiveState();
      } else {
        this.machines.set(currentId, {
          ...current,
          status: 'available',
          trust: 'identity-mismatch',
          observedDeviceId: descriptor.deviceId,
          serverEpoch: descriptor.serverEpoch,
          lastSeenAt: this.now().toISOString()
        });
        await this.persist();
        this.publish();
        throw new ConnectionIdentityMismatchError(
          endpoint,
          current.deviceId,
          descriptor.deviceId
        );
      }
    }

    if (currentId === 'local') {
      this.machines.set('local', descriptorProjection({
        ...current,
        endpointAliases: [],
        trust: 'local',
        isSelf: true
      }, descriptor, negotiated));
      await this.persist();
      return this.publish();
    }

    const targetId = deviceConnectionId(descriptor.deviceId);
    const target = this.machines.get(targetId);
    const endpointAliases = mergeAliases(
      target?.endpointAliases ?? [],
      current.endpointAliases,
      [endpoint]
    );
    const active = this.activeId === currentId || this.activeId === targetId;
    const merged: MachineConnection = descriptorProjection({
      ...(target ?? current),
      id: targetId,
      endpoint,
      endpointAliases,
      source: target?.source === 'manual' || current.source === 'manual'
        ? 'manual'
        : 'discovered',
      status: 'available',
      trust: 'pinned',
      active,
      isSelf: false,
      lastSeenAt: this.now().toISOString()
    }, descriptor, negotiated);
    if (currentId !== targetId) this.machines.delete(currentId);
    this.machines.set(targetId, merged);
    if (active) this.activeId = targetId;
    this.applyActiveState();
    await this.persist();
    return this.publish();
  }

  async bindLocalDescriptor(
    input: DeviceDescriptor,
    compatibility?: DeviceProtocolCompatibility
  ): Promise<ConnectionSnapshot> {
    await this.init();
    const descriptor = parseDeviceDescriptor(input);
    const local = this.machines.get('local');
    if (!local) throw new Error('The local device connection is unavailable.');
    if (local.deviceId && local.deviceId !== descriptor.deviceId) {
      throw new ConnectionIdentityMismatchError(
        'local',
        local.deviceId,
        descriptor.deviceId
      );
    }
    this.machines.set('local', descriptorProjection(
      local,
      descriptor,
      compatibility ?? negotiateDeviceProtocol(descriptor.protocol)
    ));
    return this.publish();
  }

  async remove(id: ConnectionId): Promise<ConnectionSnapshot> {
    await this.init();
    if (id === 'local') throw new Error('The local device connection cannot be removed.');
    if (id === this.activeId) throw new Error('Switch away from this device before forgetting it.');
    this.machines.delete(id);
    await this.persist();
    return this.publish();
  }

  async setEnabled(id: ConnectionId, enabled: boolean): Promise<ConnectionSnapshot> {
    await this.init();
    const machine = this.machines.get(id);
    if (!machine) throw new Error(`Unknown Soloe Device: ${id}`);
    if (id === 'local' && !enabled) throw new Error('The local Device cannot be disabled.');
    if (enabled && id !== 'local') {
      if (!machine.deviceId || machine.trust !== 'pinned') {
        throw new Error('Verify the Device identity before enabling this connection.');
      }
      if (machine.compatibility && machine.compatibility.status !== 'compatible') {
        throw new Error('This Device is not protocol-compatible with the client.');
      }
      if (machine.updateRequired) {
        throw new Error('Update Soloe on this Device before connecting it.');
      }
      const enabledCount = [...this.machines.values()].filter((candidate) => candidate.enabled).length;
      if (!machine.enabled && enabledCount >= MAX_ENABLED_CONNECTIONS) {
        throw new Error(`Client supports at most ${MAX_ENABLED_CONNECTIONS} enabled Devices.`);
      }
    }
    this.machines.set(id, { ...machine, enabled });
    await this.persist();
    return this.publish();
  }

  async select(id: ConnectionId): Promise<ConnectionSelectionResult> {
    await this.init();
    const machine = this.machines.get(id);
    if (!machine) throw new Error(`Unknown Soloe device: ${id}`);
    if (machine.trust === 'identity-mismatch') {
      throw new Error(`${machine.name} no longer presents its pinned Device identity.`);
    }
    if (machine.status === 'unavailable') {
      throw new Error(`${machine.name} is not currently reachable.`);
    }
    if (id === this.activeId) return { activeId: id, relaunching: false };
    this.activeId = id;
    this.applyActiveState();
    await this.persist();
    this.publish();
    return { activeId: id, relaunching: true };
  }

  onChange(listener: (snapshot: ConnectionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async refreshNow(): Promise<ConnectionSnapshot> {
    await this.init();
    if (!this.tailscaleEnabled) {
      this.tailscale = { ...DISABLED_TAILSCALE, sharing: { ...DISABLED_TAILSCALE.sharing } };
      this.refreshedAt = this.now().toISOString();
      return this.publish();
    }
    const discovery = await this.options.discover(this.tailscaleHttpsPort);
    this.tailscale = {
      state: discovery.state,
      tailnet: discovery.tailnet,
      selfDnsName: discovery.selfDnsName,
      message: discovery.message,
      sharing: { ...discovery.sharing }
    };

    const targets = new Map<string, {
      endpoint: string;
      name: string;
      source: Exclude<MachineConnectionSource, 'local'>;
      os?: string;
      existingId?: ConnectionId;
    }>();
    for (const machine of this.machines.values()) {
      if (machine.id === 'local' || !machine.endpoint) continue;
      targets.set(machine.endpoint, {
        endpoint: machine.endpoint,
        name: machine.name,
        source: machine.source === 'manual' ? 'manual' : 'discovered',
        ...(machine.os ? { os: machine.os } : {}),
        existingId: machine.id
      });
    }
    if (discovery.state === 'connected') {
      for (const device of discovery.devices) {
        if (device.isSelf || !device.online) continue;
        const endpoint = normalizeSoloeEndpoint(
          `https://${device.dnsName}:${this.tailscaleHttpsPort}`
        );
        const existing = this.findByEndpoint(endpoint);
        targets.set(endpoint, {
          endpoint,
          name: existing?.[1].trust === 'pinned' ? existing[1].name : device.name,
          source: existing?.[1].source === 'manual' ? 'manual' : 'discovered',
          ...(device.os ? { os: device.os } : {}),
          existingId: existing?.[0] ?? connectionIdForEndpoint(endpoint)
        });
      }
    }

    const results = await Promise.all(
      [...targets.values()].slice(0, MAX_CONNECTIONS).map(async (target) => {
        const available = await this.options.probe(target.endpoint).catch(() => false);
        const described = available && this.options.describe
          ? await this.options.describe(target.endpoint).catch(() => undefined)
          : undefined;
        return { target, available, described };
      })
    );
    const seenAt = this.now().toISOString();
    for (const { target, available } of results) {
      const id = target.existingId ?? connectionIdForEndpoint(target.endpoint);
      const existing = this.machines.get(id);
      if (!available && !existing) continue;
      this.machines.set(id, {
        ...(existing ?? provisionalMachine(id, target.endpoint, target.name)),
        id,
        name: existing?.trust === 'pinned' ? existing.name : target.name,
        endpoint: target.endpoint,
        endpointAliases: mergeAliases(existing?.endpointAliases ?? [], [target.endpoint]),
        source: target.source,
        status: available ? 'available' : 'unavailable',
        active: id === this.activeId,
        isSelf: false,
        ...(target.os && existing?.trust !== 'pinned' ? { os: target.os } : {}),
        ...(available
          ? { lastSeenAt: seenAt }
          : existing?.lastSeenAt
            ? { lastSeenAt: existing.lastSeenAt }
            : {})
      });
    }
    this.refreshedAt = seenAt;
    await this.persist();
    for (const { target, described } of results) {
      if (!described) continue;
      try {
        await this.bindDescriptor(
          target.endpoint,
          described.descriptor,
          described.compatibility
        );
      } catch (error) {
        if (!(error instanceof ConnectionIdentityMismatchError)) throw error;
      }
    }
    return this.publish();
  }

  private resetLocalMachine(): void {
    this.machines.set('local', {
      id: 'local',
      name: this.options.localName,
      endpoint: null,
      endpointAliases: [],
      source: 'local',
      status: 'available',
      trust: 'local',
      enabled: true,
      active: true,
      isSelf: true
    });
  }

  private findByEndpoint(endpoint: string): [ConnectionId, MachineConnection] | undefined {
    for (const entry of this.machines) {
      if (entry[1].endpoint === endpoint || entry[1].endpointAliases.includes(endpoint)) {
        return entry;
      }
    }
    return undefined;
  }

  private applyActiveState(): void {
    for (const [id, machine] of this.machines) {
      this.machines.set(id, { ...machine, active: id === this.activeId });
    }
  }

  private snapshot(): ConnectionSnapshot {
    const machines = [...this.machines.values()]
      .map((machine) => cloneMachine(machine))
      .sort((left, right) => {
        if (left.id === 'local') return -1;
        if (right.id === 'local') return 1;
        if (left.active !== right.active) return left.active ? -1 : 1;
        if (left.status !== right.status) return left.status === 'available' ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
    return {
      activeId: this.activeId,
      machines,
      preferences: {
        tailscaleEnabled: this.tailscaleEnabled,
        tailscaleHttpsPort: this.tailscaleHttpsPort
      },
      tailscale: {
        ...this.tailscale,
        sharing: { ...this.tailscale.sharing }
      },
      refreshedAt: this.refreshedAt
    };
  }

  private publish(): ConnectionSnapshot {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Listener failures must not interrupt persistence or discovery.
      }
    }
    return snapshot;
  }

  private persist(): Promise<void> {
    const persisted: PersistedConnectionsV3 = {
      version: 3,
      activeId: this.activeId,
      preferences: {
        tailscaleEnabled: this.tailscaleEnabled,
        tailscaleHttpsPort: this.tailscaleHttpsPort
      },
      machines: [...this.machines.values()]
        .filter((machine): machine is MachineConnection & { endpoint: string } =>
          machine.id !== 'local' && machine.endpoint !== null
        )
        .slice(0, MAX_CONNECTIONS)
        .map(persistedMachine)
    };
    const write = this.persistQueue.then(async () => {
      await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
      const temporary = `${this.options.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(persisted, null, 2), 'utf8');
      await fs.rename(temporary, this.options.filePath);
    });
    this.persistQueue = write.catch(() => undefined);
    return write;
  }

  private async backupV1AndPersist(source: string): Promise<void> {
    const backup = `${this.options.filePath}.v1.bak`;
    try {
      await fs.writeFile(backup, source, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await this.persist();
  }
}

export class ConnectionIdentityMismatchError extends Error {
  readonly code = 'device_identity_mismatch';

  constructor(
    readonly endpoint: string,
    readonly expectedDeviceId: DeviceId,
    readonly observedDeviceId: DeviceId
  ) {
    super(`Endpoint ${endpoint} presents Device ${observedDeviceId}, not pinned Device ${expectedDeviceId}.`);
    this.name = 'ConnectionIdentityMismatchError';
  }
}

export function normalizeSoloeEndpoint(rawValue: string): string {
  const value = rawValue.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter the root HTTPS address of a Soloe machine.');
  }
  if (
    url.protocol !== 'https:'
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('Enter a trusted root HTTPS address without a path, query, or credentials.');
  }
  url.hostname = url.hostname.replace(/\.$/u, '').toLowerCase();
  url.pathname = '';
  return url.origin;
}

export function connectionIdForEndpoint(endpoint: string): ConnectionId {
  const url = new URL(normalizeSoloeEndpoint(endpoint));
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  return `tailscale:${host}`;
}

export function deviceConnectionId(deviceId: DeviceId): ConnectionId {
  if (!isDeviceId(deviceId)) throw new Error('Device ID must be a UUID.');
  return `device:${deviceId}`;
}

function provisionalMachine(
  id: ConnectionId,
  endpoint: string,
  name: string
): MachineConnection {
  return {
    id,
    name,
    endpoint,
    endpointAliases: [endpoint],
    source: 'discovered',
    status: 'unknown',
    trust: 'provisional',
    enabled: false,
    updateRequired: true,
    active: false,
    isSelf: false
  };
}

function descriptorProjection(
  machine: MachineConnection,
  descriptor: DeviceDescriptor,
  compatibility: DeviceProtocolCompatibility
): MachineConnection {
  const updateRequired = machine.id !== 'local'
    && (
      compatibility.status !== 'compatible'
      || REQUIRED_MULTI_DEVICE_CAPABILITIES.some(
        (capability) => !descriptor.capabilities.features.includes(capability)
      )
    );
  return {
    ...machine,
    name: descriptor.name,
    deviceId: descriptor.deviceId,
    trust: machine.id === 'local' ? 'local' : 'pinned',
    os: descriptor.platform,
    protocol: { ...descriptor.protocol },
    compatibility: { ...compatibility },
    capabilityRevision: descriptor.capabilities.revision,
    capabilities: [...descriptor.capabilities.features],
    serverEpoch: descriptor.serverEpoch,
    observedDeviceId: undefined,
    updateRequired,
    enabled: machine.id === 'local'
      || (!updateRequired && (machine.source === 'discovered' || machine.enabled))
  };
}

function numericEnvironmentPort(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function validTailscalePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error('Tailscale Serve HTTPS port must be a valid TCP port.');
  }
  return value;
}

function normalizePersistedTailscalePort(value: number): number {
  return value === LEGACY_TAILSCALE_HTTPS_PORT
    ? DEFAULT_TAILSCALE_HTTPS_PORT
    : value;
}

function persistedMachineProjection(
  machine: PersistedMachineV1 | PersistedMachineV2,
  activeId: ConnectionId
): MachineConnection {
  const versionTwo = 'endpointAliases' in machine;
  const protocol = versionTwo ? machine.protocol : undefined;
  return {
    id: machine.id,
    name: machine.name,
    endpoint: machine.endpoint,
    endpointAliases: versionTwo ? [...machine.endpointAliases] : [machine.endpoint],
    source: machine.source,
    status: 'unknown',
    trust: versionTwo ? machine.trust : 'provisional',
    enabled: versionTwo ? machine.enabled ?? machine.id === activeId : machine.id === activeId,
    ...(versionTwo && machine.updateRequired !== undefined
      ? { updateRequired: machine.updateRequired }
      : {}),
    active: machine.id === activeId,
    isSelf: false,
    ...(versionTwo && machine.deviceId ? { deviceId: machine.deviceId } : {}),
    ...(versionTwo && machine.observedDeviceId
      ? { observedDeviceId: machine.observedDeviceId }
      : {}),
    ...(machine.os ? { os: machine.os } : {}),
    ...(protocol
      ? {
          protocol: { ...protocol },
          compatibility: negotiateDeviceProtocol(protocol)
        }
      : {}),
    ...(versionTwo && machine.capabilityRevision
      ? { capabilityRevision: machine.capabilityRevision }
      : {}),
    ...(versionTwo && machine.capabilities
      ? { capabilities: [...machine.capabilities] }
      : {}),
    ...(versionTwo && machine.serverEpoch ? { serverEpoch: machine.serverEpoch } : {}),
    ...(machine.lastSeenAt ? { lastSeenAt: machine.lastSeenAt } : {})
  };
}

function persistedMachine(
  machine: MachineConnection & { endpoint: string }
): PersistedMachineV2 {
  return {
    id: machine.id,
    name: machine.name,
    endpoint: machine.endpoint,
    endpointAliases: [...machine.endpointAliases],
    source: machine.source === 'manual' ? 'manual' : 'discovered',
    trust: machine.trust === 'local' ? 'provisional' : machine.trust,
    enabled: machine.enabled,
    updateRequired: machine.updateRequired === true,
    ...(machine.deviceId ? { deviceId: machine.deviceId } : {}),
    ...(machine.observedDeviceId ? { observedDeviceId: machine.observedDeviceId } : {}),
    ...(machine.os ? { os: machine.os } : {}),
    ...(machine.protocol ? { protocol: { ...machine.protocol } } : {}),
    ...(machine.capabilityRevision ? { capabilityRevision: machine.capabilityRevision } : {}),
    ...(machine.capabilities ? { capabilities: [...machine.capabilities] } : {}),
    ...(machine.serverEpoch ? { serverEpoch: machine.serverEpoch } : {}),
    ...(machine.lastSeenAt ? { lastSeenAt: machine.lastSeenAt } : {})
  };
}

function cloneMachine(machine: MachineConnection): MachineConnection {
  return {
    ...machine,
    endpointAliases: [...machine.endpointAliases],
    ...(machine.capabilities ? { capabilities: [...machine.capabilities] } : {}),
    ...(machine.protocol ? { protocol: { ...machine.protocol } } : {}),
    ...(machine.compatibility ? { compatibility: { ...machine.compatibility } } : {})
  };
}

function mergeAliases(...groups: string[][]): string[] {
  const result: string[] = [];
  for (const group of groups) {
    for (const rawEndpoint of group) {
      let endpoint: string;
      try {
        endpoint = normalizeSoloeEndpoint(rawEndpoint);
      } catch {
        continue;
      }
      if (!result.includes(endpoint)) result.push(endpoint);
      if (result.length >= MAX_ENDPOINT_ALIASES) return result;
    }
  }
  return result;
}

function displayNameForEndpoint(endpoint: string): string {
  return new URL(endpoint).hostname.split('.')[0] || new URL(endpoint).hostname;
}

function parsePersisted(value: unknown): ParsedConnections | null {
  if (!isRecord(value) || !Array.isArray(value['machines'])) return null;
  if (value['version'] === 1) {
    const activeId = parseConnectionId(value['activeId']) ?? 'local';
    const machines = value['machines']
      .map(parsePersistedMachineV1)
      .filter((machine): machine is PersistedMachineV1 => machine !== null)
      .slice(0, MAX_CONNECTIONS);
    return { version: 1, activeId, machines };
  }
  if (value['version'] === 2) {
    const activeId = parseConnectionId(value['activeId']) ?? 'local';
    const machines = value['machines']
      .map(parsePersistedMachineV2)
      .filter((machine): machine is PersistedMachineV2 => machine !== null)
      .slice(0, MAX_CONNECTIONS);
    return { version: 2, activeId, machines };
  }
  if (value['version'] === 3 && isRecord(value['preferences'])) {
    const activeId = parseConnectionId(value['activeId']) ?? 'local';
    const machines = value['machines']
      .map(parsePersistedMachineV2)
      .filter((machine): machine is PersistedMachineV2 => machine !== null)
      .slice(0, MAX_CONNECTIONS);
    const port = Number(value['preferences']['tailscaleHttpsPort']);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
    return {
      version: 3,
      activeId,
      preferences: {
        tailscaleEnabled: value['preferences']['tailscaleEnabled'] !== false,
        tailscaleHttpsPort: normalizePersistedTailscalePort(port)
      },
      machines
    };
  }
  return null;
}

function parsePersistedMachineV1(value: unknown): PersistedMachineV1 | null {
  const common = parsePersistedMachineCommon(value);
  if (!common || connectionIdForEndpoint(common.endpoint) !== common.id) return null;
  return common;
}

function parsePersistedMachineV2(value: unknown): PersistedMachineV2 | null {
  const common = parsePersistedMachineCommon(value);
  if (!common || !isRecord(value)) return null;
  const deviceId = isDeviceId(value['deviceId']) ? value['deviceId'] : undefined;
  const idDevice = common.id.startsWith('device:') ? common.id.slice('device:'.length) : null;
  if ((idDevice !== null && (!deviceId || idDevice !== deviceId)) || (idDevice === null && deviceId)) {
    return null;
  }
  if (idDevice === null && connectionIdForEndpoint(common.endpoint) !== common.id) return null;
  const trust = parseTrust(value['trust'], Boolean(deviceId));
  if (!trust) return null;
  const enabled = typeof value['enabled'] === 'boolean' ? value['enabled'] : undefined;
  const updateRequired = typeof value['updateRequired'] === 'boolean'
    ? value['updateRequired']
    : undefined;
  const aliases = Array.isArray(value['endpointAliases'])
    ? mergeAliases([common.endpoint], value['endpointAliases'].filter(
        (endpoint): endpoint is string => typeof endpoint === 'string'
      ))
    : [common.endpoint];
  const observedDeviceId = isDeviceId(value['observedDeviceId'])
    ? value['observedDeviceId']
    : undefined;
  if ((trust === 'identity-mismatch') !== Boolean(observedDeviceId)) return null;
  const protocol = parseProtocol(value['protocol']);
  const capabilityRevision = boundedToken(value['capabilityRevision']);
  const capabilities = parseCapabilities(value['capabilities']);
  const serverEpoch = isDeviceId(value['serverEpoch']) ? value['serverEpoch'] : undefined;
  return {
    ...common,
    endpointAliases: aliases,
    trust,
    ...(enabled !== undefined ? { enabled } : {}),
    ...(updateRequired !== undefined ? { updateRequired } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(observedDeviceId ? { observedDeviceId } : {}),
    ...(protocol ? { protocol } : {}),
    ...(capabilityRevision ? { capabilityRevision } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(serverEpoch ? { serverEpoch } : {})
  };
}

function parsePersistedMachineCommon(value: unknown): PersistedMachineV1 | null {
  if (!isRecord(value)) return null;
  const id = parseConnectionId(value['id']);
  const name = typeof value['name'] === 'string' ? value['name'].trim() : '';
  const source = value['source'] === 'manual' ? 'manual' : 'discovered';
  if (!id || id === 'local' || !name || name.length > 128 || typeof value['endpoint'] !== 'string') {
    return null;
  }
  let endpoint: string;
  try {
    endpoint = normalizeSoloeEndpoint(value['endpoint']);
  } catch {
    return null;
  }
  const os = typeof value['os'] === 'string' && value['os'].trim()
    ? value['os'].trim().slice(0, 64)
    : null;
  const lastSeenAt = typeof value['lastSeenAt'] === 'string' && value['lastSeenAt'].trim()
    ? value['lastSeenAt'].trim()
    : null;
  return {
    id,
    name,
    endpoint,
    source,
    ...(os ? { os } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {})
  };
}

function parseConnectionId(value: unknown): ConnectionId | null {
  if (value === 'local') return value;
  if (typeof value !== 'string') return null;
  if (value.startsWith('tailscale:') && value.length > 'tailscale:'.length) {
    return value as ConnectionId;
  }
  if (value.startsWith('device:') && isDeviceId(value.slice('device:'.length))) {
    return value as ConnectionId;
  }
  return null;
}

function parseTrust(
  value: unknown,
  hasDeviceId: boolean
): Exclude<MachineConnectionTrust, 'local'> | null {
  if (!hasDeviceId) return value === 'provisional' ? 'provisional' : null;
  return value === 'pinned' || value === 'identity-mismatch' ? value : null;
}

function parseProtocol(value: unknown): DeviceProtocolRange | undefined {
  if (!isRecord(value)) return undefined;
  const range = {
    current: value['current'],
    minimum: value['minimum'],
    maximum: value['maximum']
  };
  if (
    !Number.isSafeInteger(range.current)
    || !Number.isSafeInteger(range.minimum)
    || !Number.isSafeInteger(range.maximum)
  ) return undefined;
  const protocol: DeviceProtocolRange = {
    current: range.current as number,
    minimum: range.minimum as number,
    maximum: range.maximum as number
  };
  try {
    negotiateDeviceProtocol(protocol);
    return protocol;
  } catch {
    return undefined;
  }
}

function boundedToken(value: unknown): string | undefined {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && /^[a-zA-Z0-9._:-]+$/u.test(value)
    ? value
    : undefined;
}

function parseCapabilities(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 128) return undefined;
  const capabilities = value.filter((entry): entry is string =>
    typeof entry === 'string'
    && entry.length > 0
    && entry.length <= 128
    && /^[a-z][a-z0-9.-]*$/u.test(entry)
  );
  return capabilities.length === value.length && new Set(capabilities).size === capabilities.length
    ? capabilities
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
