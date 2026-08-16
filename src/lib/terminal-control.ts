import {
  terminalControlProof,
  type TerminalControllerIdentity,
  type TerminalControlProof,
  type TerminalInputLease,
  type TerminalInputLeaseEvent
} from '@shared/types/terminal.js';

export interface TerminalControlBackend {
  acquire(
    terminalId: string,
    identity: TerminalControllerIdentity,
    takeover: boolean
  ): Promise<TerminalInputLease>;
  current(terminalId: string): Promise<TerminalInputLease | null>;
  release(terminalId: string, control: TerminalControlProof): Promise<boolean>;
  input(terminalId: string, data: string, control: TerminalControlProof): Promise<void>;
  resize(terminalId: string, cols: number, rows: number, control: TerminalControlProof): Promise<void>;
  onLease(listener: (event: TerminalInputLeaseEvent) => void): () => void;
}

export function resolveTerminalControllerIdentity(
  localDevice: { deviceId: string; name: string } | null | undefined,
  fallback: TerminalControllerIdentity
): TerminalControllerIdentity {
  return localDevice
    ? { deviceId: localDevice.deviceId, deviceName: localDevice.name }
    : { ...fallback };
}

export class TerminalControlCoordinator {
  private readonly leases = new Map<string, TerminalInputLease | null>();
  private readonly owned = new Map<string, TerminalInputLease>();
  private readonly listeners = new Set<() => void>();
  private readonly takeoverRequests = new Map<string, Promise<boolean>>();
  private selectedTerminalId: string | null = null;
  private pageVisible = true;
  private selectionEpoch = 0;
  private readonly detachLease: () => void;

  constructor(
    private readonly backend: TerminalControlBackend,
    private readonly identitySource:
      | TerminalControllerIdentity
      | (() => TerminalControllerIdentity)
  ) {
    this.detachLease = backend.onLease((event) => this.apply(event));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  lease(terminalId: string): TerminalInputLease | null {
    return this.leases.get(terminalId) ?? null;
  }

  owns(terminalId: string): boolean {
    const owned = this.owned.get(terminalId);
    const observed = this.leases.get(terminalId);
    return Boolean(
      owned
      && observed
      && owned.leaseId === observed.leaseId
      && owned.sessionId === observed.sessionId
      && owned.ownerDeviceId === observed.ownerDeviceId
      && owned.controllerDeviceId === observed.controllerDeviceId
    );
  }

  isTakingOver(terminalId: string): boolean {
    return this.takeoverRequests.has(terminalId);
  }

  async select(terminalId: string | null): Promise<void> {
    const normalized = terminalId?.trim() || null;
    const previous = this.selectedTerminalId;
    const epoch = ++this.selectionEpoch;
    this.selectedTerminalId = normalized;
    if (previous && previous !== normalized) await this.release(previous);
    if (!normalized || !this.pageVisible || epoch !== this.selectionEpoch) return;
    await this.claim(normalized, false, epoch);
  }

  async setPageVisible(visible: boolean): Promise<void> {
    if (this.pageVisible === visible) return;
    this.pageVisible = visible;
    const terminalId = this.selectedTerminalId;
    const epoch = ++this.selectionEpoch;
    if (!terminalId) return;
    if (!visible) {
      await this.release(terminalId);
      return;
    }
    await this.claim(terminalId, false, epoch);
  }

  takeover(terminalId: string): Promise<boolean> {
    const existing = this.takeoverRequests.get(terminalId);
    if (existing) return existing;
    const request = this.claim(terminalId, true, this.selectionEpoch)
      .finally(() => {
        this.takeoverRequests.delete(terminalId);
        this.notify();
      });
    this.takeoverRequests.set(terminalId, request);
    this.notify();
    return request;
  }

  async refresh(terminalId: string): Promise<TerminalInputLease | null> {
    const lease = await this.backend.current(terminalId);
    this.leases.set(terminalId, lease);
    this.reconcileOwnedLease(terminalId, lease);
    this.notify();
    return lease;
  }

  async release(terminalId: string): Promise<void> {
    const lease = this.owned.get(terminalId);
    this.owned.delete(terminalId);
    if (!lease) return;
    this.notify();
    await this.backend.release(terminalId, terminalControlProof(lease)).catch(() => false);
  }

  async input(terminalId: string, data: string): Promise<void> {
    const lease = this.requiredLease(terminalId);
    try {
      await this.backend.input(terminalId, data, terminalControlProof(lease));
    } catch (error) {
      await this.refresh(terminalId).catch(() => null);
      throw error;
    }
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const lease = this.requiredLease(terminalId);
    if (lease.cols === cols && lease.rows === rows) return;
    try {
      await this.backend.resize(terminalId, cols, rows, terminalControlProof(lease));
    } catch (error) {
      await this.refresh(terminalId).catch(() => null);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.detachLease();
    const terminalIds = [...this.owned.keys()];
    await Promise.all(terminalIds.map((terminalId) => this.release(terminalId)));
    this.listeners.clear();
  }

  private async claim(
    terminalId: string,
    takeover: boolean,
    selectionEpoch: number
  ): Promise<boolean> {
    try {
      const lease = await this.backend.acquire(terminalId, this.identity(), takeover);
      const observed = this.leases.get(terminalId);
      if (observed && observed.generation > lease.generation) return false;
      if (!takeover && (
        !this.pageVisible
        || this.selectedTerminalId !== terminalId
        || selectionEpoch !== this.selectionEpoch
      )) {
        await this.backend.release(terminalId, terminalControlProof(lease)).catch(() => false);
        return false;
      }
      this.leases.set(terminalId, lease);
      this.owned.set(terminalId, lease);
      this.notify();
      return true;
    } catch {
      await this.refresh(terminalId).catch(() => null);
      return false;
    }
  }

  private requiredLease(terminalId: string): TerminalInputLease {
    if (!this.owns(terminalId)) throw new Error('Terminal control lease is required.');
    return this.owned.get(terminalId)!;
  }

  private apply(event: TerminalInputLeaseEvent): void {
    const current = this.leases.get(event.terminalId);
    const incomingGeneration = event.lease?.generation ?? event.generation ?? 0;
    if (current && current.generation > incomingGeneration) return;
    this.leases.set(event.terminalId, event.lease ? structuredClone(event.lease) : null);
    this.reconcileOwnedLease(event.terminalId, event.lease);
    this.notify();
  }

  private reconcileOwnedLease(
    terminalId: string,
    lease: TerminalInputLease | null | undefined
  ): void {
    if (lease?.controllerDeviceId === this.identity().deviceId) {
      this.owned.set(terminalId, structuredClone(lease));
      return;
    }
    const owned = this.owned.get(terminalId);
    if (owned && !sameControl(owned, lease)) this.owned.delete(terminalId);
  }

  private identity(): TerminalControllerIdentity {
    const identity = typeof this.identitySource === 'function'
      ? this.identitySource()
      : this.identitySource;
    return { ...identity };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function sameControl(
  owned: TerminalInputLease,
  observed: TerminalInputLease | null | undefined
): boolean {
  return Boolean(
    observed
    && owned.leaseId === observed.leaseId
    && owned.sessionId === observed.sessionId
    && owned.ownerDeviceId === observed.ownerDeviceId
    && owned.controllerDeviceId === observed.controllerDeviceId
  );
}
