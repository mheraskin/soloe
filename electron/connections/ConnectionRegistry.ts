import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ConnectionId,
  ConnectionSelectionResult,
  ConnectionSnapshot,
  MachineConnection,
  MachineConnectionSource,
  TailscaleConnectionInfo
} from '@shared/types/connections.js';
import type { TailscaleDiscoveryResult } from './TailscaleDiscovery.js';

interface PersistedMachine {
  id: ConnectionId;
  name: string;
  endpoint: string;
  source: Exclude<MachineConnectionSource, 'local'>;
  os?: string;
  lastSeenAt?: string;
}

interface PersistedConnections {
  version: 1;
  activeId: ConnectionId;
  machines: PersistedMachine[];
}

export interface ConnectionRegistryOptions {
  filePath: string;
  localName: string;
  discover: () => Promise<TailscaleDiscoveryResult>;
  probe: (endpoint: string) => Promise<boolean>;
  now?: () => Date;
}

const EMPTY_TAILSCALE: TailscaleConnectionInfo = {
  state: 'unavailable',
  tailnet: null,
  selfDnsName: null,
  message: 'Refresh to discover Soloe machines on this tailnet.'
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

  constructor(private readonly options: ConnectionRegistryOptions) {
    this.now = options.now ?? (() => new Date());
    this.resetLocalMachine();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    let parsed: PersistedConnections | null = null;
    try {
      parsed = parsePersisted(JSON.parse(await fs.readFile(this.options.filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[connections] ignored unreadable connection registry', error);
      }
    }
    if (!parsed) return;
    this.activeId = parsed.activeId;
    for (const machine of parsed.machines) {
      this.machines.set(machine.id, {
        ...machine,
        status: 'unknown',
        active: machine.id === this.activeId,
        isSelf: false
      });
    }
    if (this.activeId !== 'local' && !this.machines.has(this.activeId)) {
      this.activeId = 'local';
    }
    this.applyActiveState();
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

  async add(rawEndpoint: string): Promise<ConnectionSnapshot> {
    await this.init();
    const endpoint = normalizeSoloeEndpoint(rawEndpoint);
    const id = connectionIdForEndpoint(endpoint);
    const existing = this.machines.get(id);
    const available = await this.options.probe(endpoint);
    const seenAt = available ? this.now().toISOString() : existing?.lastSeenAt;
    this.machines.set(id, {
      id,
      name: existing?.name ?? displayNameForEndpoint(endpoint),
      endpoint,
      source: 'manual',
      status: available ? 'available' : 'unavailable',
      active: id === this.activeId,
      isSelf: false,
      ...(existing?.os ? { os: existing.os } : {}),
      ...(seenAt ? { lastSeenAt: seenAt } : {})
    });
    await this.persist();
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

  async select(id: ConnectionId): Promise<ConnectionSelectionResult> {
    await this.init();
    const machine = this.machines.get(id);
    if (!machine) throw new Error(`Unknown Soloe device: ${id}`);
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
    const discovery = await this.options.discover();
    this.tailscale = {
      state: discovery.state,
      tailnet: discovery.tailnet,
      selfDnsName: discovery.selfDnsName,
      message: discovery.message
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
        const endpoint = `https://${device.dnsName}`;
        targets.set(endpoint, {
          endpoint,
          name: device.name,
          source: 'discovered',
          ...(device.os ? { os: device.os } : {}),
          existingId: connectionIdForEndpoint(endpoint)
        });
      }
    }

    const results = await Promise.all(
      [...targets.values()].slice(0, 64).map(async (target) => ({
        target,
        available: await this.options.probe(target.endpoint).catch(() => false)
      }))
    );
    const seenAt = this.now().toISOString();
    for (const { target, available } of results) {
      const id = target.existingId ?? connectionIdForEndpoint(target.endpoint);
      const existing = this.machines.get(id);
      if (!available && !existing) continue;
      this.machines.set(id, {
        id,
        name: target.name,
        endpoint: target.endpoint,
        source: target.source,
        status: available ? 'available' : 'unavailable',
        active: id === this.activeId,
        isSelf: false,
        ...(target.os ? { os: target.os } : {}),
        ...(available
          ? { lastSeenAt: seenAt }
          : existing?.lastSeenAt
            ? { lastSeenAt: existing.lastSeenAt }
            : {})
      });
    }
    this.refreshedAt = seenAt;
    await this.persist();
    return this.publish();
  }

  private resetLocalMachine(): void {
    this.machines.set('local', {
      id: 'local',
      name: this.options.localName,
      endpoint: null,
      source: 'local',
      status: 'available',
      active: true,
      isSelf: true
    });
  }

  private applyActiveState(): void {
    for (const [id, machine] of this.machines) {
      this.machines.set(id, { ...machine, active: id === this.activeId });
    }
  }

  private snapshot(): ConnectionSnapshot {
    const machines = [...this.machines.values()]
      .map((machine) => ({ ...machine }))
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
      tailscale: { ...this.tailscale },
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
    const persisted: PersistedConnections = {
      version: 1,
      activeId: this.activeId,
      machines: [...this.machines.values()]
        .filter((machine): machine is MachineConnection & { endpoint: string } =>
          machine.id !== 'local' && machine.endpoint !== null
        )
        .slice(0, 64)
        .map((machine) => ({
          id: machine.id,
          name: machine.name,
          endpoint: machine.endpoint,
          source: machine.source === 'manual' ? 'manual' : 'discovered',
          ...(machine.os ? { os: machine.os } : {}),
          ...(machine.lastSeenAt ? { lastSeenAt: machine.lastSeenAt } : {})
        }))
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

function displayNameForEndpoint(endpoint: string): string {
  return new URL(endpoint).hostname.split('.')[0] || new URL(endpoint).hostname;
}

function parsePersisted(value: unknown): PersistedConnections | null {
  if (!isRecord(value) || value['version'] !== 1 || !Array.isArray(value['machines'])) return null;
  const activeId = parseConnectionId(value['activeId']) ?? 'local';
  const machines = value['machines']
    .map((machine) => parsePersistedMachine(machine))
    .filter((machine): machine is PersistedMachine => machine !== null)
    .slice(0, 64);
  return { version: 1, activeId, machines };
}

function parsePersistedMachine(value: unknown): PersistedMachine | null {
  if (!isRecord(value)) return null;
  const id = parseConnectionId(value['id']);
  const name = typeof value['name'] === 'string' ? value['name'].trim() : '';
  const source = value['source'] === 'manual' ? 'manual' : 'discovered';
  if (!id || id === 'local' || !name || typeof value['endpoint'] !== 'string') return null;
  let endpoint: string;
  try {
    endpoint = normalizeSoloeEndpoint(value['endpoint']);
  } catch {
    return null;
  }
  if (connectionIdForEndpoint(endpoint) !== id) return null;
  const os = typeof value['os'] === 'string' && value['os'].trim() ? value['os'].trim() : null;
  const lastSeenAt =
    typeof value['lastSeenAt'] === 'string' && value['lastSeenAt'].trim()
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
  return typeof value === 'string' && value.startsWith('tailscale:')
    ? value as ConnectionId
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
