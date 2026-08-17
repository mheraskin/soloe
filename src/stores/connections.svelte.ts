import type {
  ConnectionId,
  ConnectionSnapshot,
  MachineConnection
} from '@shared/types/connections.js';
import { ipc, supportsBackendOperation } from '../lib/ipc';

const DISCOVERY_INTERVAL_MS = 30_000;

const EMPTY_SNAPSHOT: ConnectionSnapshot = {
  activeId: 'local',
  machines: [],
  preferences: {
    tailscaleEnabled: true,
    tailscaleHttpsPort: 443
  },
  tailscale: {
    state: 'unavailable',
    tailnet: null,
    selfDnsName: null,
    message: null,
    sharing: {
      state: 'unavailable',
      message: 'Install Tailscale to connect this Soloe Device to other machines.',
      setupUrl: 'https://tailscale.com/download'
    }
  },
  refreshedAt: null
};

export class ConnectionsStore {
  readonly supported = supportsBackendOperation('connections', 'get');
  snapshot = $state<ConnectionSnapshot>(structuredClone(EMPTY_SNAPSHOT));
  loaded = $state(false);
  refreshing = $state(false);
  switchingId = $state<ConnectionId | null>(null);

  private detachChange: (() => void) | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private loadRequest: Promise<void> | null = null;
  private refreshRequest: Promise<void> | null = null;

  get active(): MachineConnection | null {
    return this.snapshot.machines.find((machine) => machine.id === this.snapshot.activeId) ?? null;
  }

  load(): Promise<void> {
    if (!this.supported) {
      this.loaded = true;
      return Promise.resolve();
    }
    if (this.loadRequest) return this.loadRequest;
    this.loadRequest = ipc.connections.get()
      .then((snapshot) => {
        this.updateSnapshot(snapshot);
        this.loaded = true;
        void this.refresh({ visible: false }).catch(() => undefined);
      })
      .finally(() => {
        this.loadRequest = null;
      });
    return this.loadRequest;
  }

  refresh(options: { visible?: boolean } = {}): Promise<void> {
    if (!this.supported) return Promise.resolve();
    if (this.refreshRequest) return this.refreshRequest;
    const visible = options.visible ?? true;
    if (visible) this.refreshing = true;
    this.refreshRequest = ipc.connections.refresh()
      .then((snapshot) => {
        this.updateSnapshot(snapshot);
      })
      .finally(() => {
        if (visible) this.refreshing = false;
        this.refreshRequest = null;
      });
    return this.refreshRequest;
  }

  async add(endpoint: string): Promise<void> {
    this.snapshot = await ipc.connections.add({ endpoint });
  }

  async configureTailscale(patch: {
    tailscaleEnabled?: boolean;
    tailscaleHttpsPort?: number;
  }): Promise<void> {
    this.snapshot = await ipc.connections.configure(patch);
  }

  async remove(id: ConnectionId): Promise<void> {
    this.snapshot = await ipc.connections.remove(id);
  }

  async setEnabled(id: ConnectionId, enabled: boolean): Promise<void> {
    this.snapshot = await ipc.connections.setEnabled(id, enabled);
  }

  async select(id: ConnectionId): Promise<void> {
    if (id === this.snapshot.activeId || this.switchingId) return;
    this.switchingId = id;
    try {
      const result = await ipc.connections.select(id);
      if (!result.relaunching) this.switchingId = null;
    } catch (error) {
      this.switchingId = null;
      throw error;
    }
  }

  attachListeners(): void {
    this.detach();
    if (!this.supported) return;
    this.detachChange = ipc.connections.onChange((snapshot) => {
      this.updateSnapshot(snapshot);
    });
    this.discoveryTimer = setInterval(() => {
      void this.refresh({ visible: false }).catch(() => undefined);
    }, DISCOVERY_INTERVAL_MS);
  }

  private updateSnapshot(snapshot: ConnectionSnapshot): void {
    if (sameConnectionSnapshot(this.snapshot, snapshot)) return;
    this.snapshot = snapshot;
  }

  detach(): void {
    this.detachChange?.();
    this.detachChange = null;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = null;
  }
}

function sameConnectionSnapshot(left: ConnectionSnapshot, right: ConnectionSnapshot): boolean {
  const { refreshedAt: _leftRefreshedAt, ...leftContent } = left;
  const { refreshedAt: _rightRefreshedAt, ...rightContent } = right;
  return JSON.stringify({
    ...leftContent,
    machines: leftContent.machines.map(({ lastSeenAt: _lastSeenAt, ...machine }) => machine)
  }) === JSON.stringify({
    ...rightContent,
    machines: rightContent.machines.map(({ lastSeenAt: _lastSeenAt, ...machine }) => machine)
  });
}

export const connections = new ConnectionsStore();
