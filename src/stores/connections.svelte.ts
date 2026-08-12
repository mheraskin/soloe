import type {
  ConnectionId,
  ConnectionSnapshot,
  MachineConnection
} from '@shared/types/connections.js';
import { ipc, supportsBackendOperation } from '../lib/ipc';

const EMPTY_SNAPSHOT: ConnectionSnapshot = {
  activeId: 'local',
  machines: [],
  tailscale: {
    state: 'unavailable',
    tailnet: null,
    selfDnsName: null,
    message: null
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
        this.snapshot = snapshot;
        this.loaded = true;
        void this.refresh().catch(() => undefined);
      })
      .finally(() => {
        this.loadRequest = null;
      });
    return this.loadRequest;
  }

  refresh(): Promise<void> {
    if (!this.supported) return Promise.resolve();
    if (this.refreshRequest) return this.refreshRequest;
    this.refreshing = true;
    this.refreshRequest = ipc.connections.refresh()
      .then((snapshot) => {
        this.snapshot = snapshot;
      })
      .finally(() => {
        this.refreshing = false;
        this.refreshRequest = null;
      });
    return this.refreshRequest;
  }

  async add(endpoint: string): Promise<void> {
    this.snapshot = await ipc.connections.add({ endpoint });
  }

  async remove(id: ConnectionId): Promise<void> {
    this.snapshot = await ipc.connections.remove(id);
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
      this.snapshot = snapshot;
    });
  }

  detach(): void {
    this.detachChange?.();
    this.detachChange = null;
  }
}

export const connections = new ConnectionsStore();
