import { randomUUID } from 'node:crypto';

import type {
  TerminalInputLease,
  TerminalInputLeaseEvent
} from '../../../shared/types/terminal.js';

const DEFAULT_TERMINAL_INPUT_LEASE_TTL_MS = 15_000;

export interface TerminalInputLeaseManagerOptions {
  ttlMs?: number;
  now?: () => number;
  leaseId?: () => string;
  onChange?: (event: TerminalInputLeaseEvent) => void;
}

export class TerminalInputLeaseError extends Error {
  readonly code: 'terminal_input_owned' | 'terminal_input_lease_required';
  readonly lease: TerminalInputLease | null;

  constructor(
    code: TerminalInputLeaseError['code'],
    message: string,
    lease: TerminalInputLease | null
  ) {
    super(message);
    this.name = 'TerminalInputLeaseError';
    this.code = code;
    this.lease = lease ? structuredClone(lease) : null;
  }
}

export class TerminalInputLeaseManager {
  private readonly leases = new Map<string, TerminalInputLease>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly nextLeaseId: () => string;

  constructor(private readonly options: TerminalInputLeaseManagerOptions = {}) {
    this.ttlMs = positiveTtl(options.ttlMs);
    this.now = options.now ?? Date.now;
    this.nextLeaseId = options.leaseId ?? randomUUID;
  }

  acquire(
    terminalId: string,
    ownerId: string,
    options: { takeover?: boolean } = {}
  ): TerminalInputLease {
    const terminal = requiredIdentity(terminalId, 'Terminal');
    const owner = requiredIdentity(ownerId, 'Terminal input owner');
    const current = this.active(terminal);
    if (current?.ownerId === owner) return this.renewLease(current);
    if (current && !options.takeover) throw ownedError(current);

    const timestamp = this.now();
    const lease: TerminalInputLease = {
      terminalId: terminal,
      leaseId: requiredIdentity(this.nextLeaseId(), 'Terminal input lease'),
      ownerId: owner,
      acquiredAt: new Date(timestamp).toISOString(),
      expiresAt: new Date(timestamp + this.ttlMs).toISOString()
    };
    this.leases.set(terminal, lease);
    this.publish({
      type: current ? 'taken-over' : 'acquired',
      terminalId: terminal,
      lease: cloneLease(lease),
      ...(current ? { previousOwnerId: current.ownerId } : {}),
      observedAt: new Date(timestamp).toISOString()
    });
    return cloneLease(lease);
  }

  authorizeInput(terminalId: string, ownerId: string, leaseId: string): TerminalInputLease {
    const terminal = requiredIdentity(terminalId, 'Terminal');
    const owner = requiredIdentity(ownerId, 'Terminal input owner');
    const requestedLease = requiredIdentity(leaseId, 'Terminal input lease');
    const current = this.active(terminal);
    if (!current) {
      throw new TerminalInputLeaseError(
        'terminal_input_lease_required',
        `Terminal ${terminal} has no active input lease.`,
        null
      );
    }
    if (current.ownerId !== owner) throw ownedError(current);
    if (current.leaseId !== requestedLease) {
      throw new TerminalInputLeaseError(
        'terminal_input_lease_required',
        `Terminal ${terminal} input lease is stale.`,
        current
      );
    }
    return this.renewLease(current);
  }

  current(terminalId: string): TerminalInputLease | null {
    const current = this.active(requiredIdentity(terminalId, 'Terminal'));
    return current ? cloneLease(current) : null;
  }

  release(terminalId: string, ownerId: string, leaseId: string): boolean {
    const terminal = requiredIdentity(terminalId, 'Terminal');
    const current = this.active(terminal);
    if (!current || current.ownerId !== ownerId || current.leaseId !== leaseId) return false;
    this.leases.delete(terminal);
    this.publish({
      type: 'released',
      terminalId: terminal,
      lease: null,
      previousOwnerId: current.ownerId,
      observedAt: new Date(this.now()).toISOString()
    });
    return true;
  }

  releaseOwner(ownerId: string): number {
    let released = 0;
    for (const lease of [...this.leases.values()]) {
      if (lease.ownerId !== ownerId) continue;
      if (this.release(lease.terminalId, lease.ownerId, lease.leaseId)) released += 1;
    }
    return released;
  }

  clearTerminal(terminalId: string): boolean {
    const terminal = requiredIdentity(terminalId, 'Terminal');
    const current = this.leases.get(terminal);
    if (!current) return false;
    this.leases.delete(terminal);
    this.publish({
      type: 'released',
      terminalId: terminal,
      lease: null,
      previousOwnerId: current.ownerId,
      observedAt: new Date(this.now()).toISOString()
    });
    return true;
  }

  clear(): void {
    for (const terminalId of [...this.leases.keys()]) this.clearTerminal(terminalId);
  }

  private active(terminalId: string): TerminalInputLease | null {
    const current = this.leases.get(terminalId);
    if (!current) return null;
    const timestamp = this.now();
    if (Date.parse(current.expiresAt) > timestamp) return current;
    this.leases.delete(terminalId);
    this.publish({
      type: 'expired',
      terminalId,
      lease: null,
      previousOwnerId: current.ownerId,
      observedAt: new Date(timestamp).toISOString()
    });
    return null;
  }

  private renewLease(current: TerminalInputLease): TerminalInputLease {
    const timestamp = this.now();
    current.expiresAt = new Date(timestamp + this.ttlMs).toISOString();
    this.publish({
      type: 'renewed',
      terminalId: current.terminalId,
      lease: cloneLease(current),
      observedAt: new Date(timestamp).toISOString()
    });
    return cloneLease(current);
  }

  private publish(event: TerminalInputLeaseEvent): void {
    try {
      this.options.onChange?.(structuredClone(event));
    } catch {
      // Lease arbitration is independent from observers.
    }
  }
}

function cloneLease(lease: TerminalInputLease): TerminalInputLease {
  return structuredClone(lease);
}

function ownedError(lease: TerminalInputLease): TerminalInputLeaseError {
  return new TerminalInputLeaseError(
    'terminal_input_owned',
    `Terminal input is controlled by ${lease.ownerId} until ${lease.expiresAt}.`,
    lease
  );
}

function requiredIdentity(value: string, label: string): string {
  const result = value.trim();
  if (!result || result.length > 512 || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new Error(`${label} identity is invalid.`);
  }
  return result;
}

function positiveTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TERMINAL_INPUT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 5 * 60_000) {
    throw new Error('Terminal input lease TTL must be between 1 and 300 seconds.');
  }
  return value;
}
