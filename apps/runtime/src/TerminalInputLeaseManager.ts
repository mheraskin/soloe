import { randomUUID } from 'node:crypto';

import {
  terminalControlProof,
  type TerminalControlProof,
  type TerminalInputLease,
  type TerminalInputLeaseEvent
} from '../../../shared/types/terminal.js';
import { DEFAULT_COLS, DEFAULT_ROWS } from '../../../shared/types/terminal.js';

export interface TerminalInputLeaseManagerOptions {
  now?: () => number;
  leaseId?: () => string;
  onChange?: (event: TerminalInputLeaseEvent) => void;
}

export class TerminalInputLeaseError extends Error {
  readonly code:
    | 'terminal_input_owned'
    | 'terminal_input_lease_required'
    | 'terminal_control_lease_stale';
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
  private readonly affinities = new Map<string, {
    controllerDeviceId: string;
    controllerDeviceName: string;
  }>();
  private readonly generations = new Map<string, number>();
  private readonly now: () => number;
  private readonly nextLeaseId: () => string;

  constructor(private readonly options: TerminalInputLeaseManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.nextLeaseId = options.leaseId ?? randomUUID;
  }

  acquire(
    terminalId: string,
    transportClientId: string,
    options: {
      takeover?: boolean;
      sessionId?: string;
      ownerDeviceId?: string;
      controllerDeviceId?: string;
      controllerDeviceName?: string;
      cols?: number;
      rows?: number;
    } = {}
  ): TerminalInputLease {
    const terminal = requiredIdentity(terminalId, 'Terminal');
    const transportClient = requiredIdentity(transportClientId, 'Terminal transport client');
    const sessionId = requiredIdentity(options.sessionId ?? terminal, 'Session');
    const ownerDeviceId = requiredIdentity(
      options.ownerDeviceId ?? options.controllerDeviceId ?? transportClient,
      'Session owner device'
    );
    const controllerDeviceId = requiredIdentity(
      options.controllerDeviceId ?? transportClient,
      'Controller device'
    );
    const current = this.active(terminal);
    if (
      current?.sessionId === sessionId
      && current.ownerDeviceId === ownerDeviceId
      && current.controllerDeviceId === controllerDeviceId
    ) {
      current.controllerDeviceName = requiredIdentity(
        options.controllerDeviceName ?? controllerDeviceId,
        'Controller device name'
      );
      return cloneLease(current);
    }
    if (current && !options.takeover) throw ownedError(current);

    const timestamp = this.now();
    const generation = (this.generations.get(terminal) ?? 0) + 1;
    this.generations.set(terminal, generation);
    const lease: TerminalInputLease = {
      terminalId: terminal,
      sessionId,
      ownerDeviceId,
      leaseId: requiredIdentity(this.nextLeaseId(), 'Terminal input lease'),
      controllerDeviceId,
      controllerDeviceName: requiredIdentity(
        options.controllerDeviceName ?? options.controllerDeviceId ?? transportClient,
        'Controller device name'
      ),
      generation,
      cols: terminalDimension(options.cols, DEFAULT_COLS, 'columns'),
      rows: terminalDimension(options.rows, DEFAULT_ROWS, 'rows'),
      acquiredAt: new Date(timestamp).toISOString()
    };
    this.leases.set(terminal, lease);
    this.affinities.set(terminal, {
      controllerDeviceId: lease.controllerDeviceId,
      controllerDeviceName: lease.controllerDeviceName
    });
    this.publish({
      type: current ? 'taken-over' : 'acquired',
      terminalId: terminal,
      lease: cloneLease(lease),
      generation: lease.generation,
      ...(current ? { previousControllerDeviceId: current.controllerDeviceId } : {}),
      observedAt: new Date(timestamp).toISOString()
    });
    return cloneLease(lease);
  }

  authorizeControl(
    terminalId: string,
    proof: TerminalControlProof,
    operation: 'input' | 'resize'
  ): TerminalInputLease {
    const terminal = requiredIdentity(terminalId, 'Terminal');
    const current = this.active(terminal);
    if (!current) {
      throw new TerminalInputLeaseError(
        'terminal_input_lease_required',
        `Terminal ${terminal} has no active control lease.`,
        null
      );
    }
    if (
      current.sessionId !== requiredIdentity(proof.sessionId, 'Session')
      || current.ownerDeviceId !== requiredIdentity(proof.ownerDeviceId, 'Session owner device')
      || current.controllerDeviceId !== requiredIdentity(
        proof.controllerDeviceId,
        'Controller device'
      )
      || current.leaseId !== requiredIdentity(proof.leaseId, 'Terminal input lease')
    ) {
      throw new TerminalInputLeaseError(
        'terminal_control_lease_stale',
        `Terminal ${terminal} ${operation} used stale Session Control.`,
        current
      );
    }
    return cloneLease(current);
  }

  resize(
    terminalId: string,
    proof: TerminalControlProof,
    cols: number,
    rows: number
  ): TerminalInputLease {
    const current = this.authorizeControl(terminalId, proof, 'resize');
    const nextCols = terminalDimension(cols, current.cols, 'columns');
    const nextRows = terminalDimension(rows, current.rows, 'rows');
    const stored = this.leases.get(current.terminalId);
    if (!stored) return current;
    if (stored.cols === nextCols && stored.rows === nextRows) return cloneLease(stored);
    stored.cols = nextCols;
    stored.rows = nextRows;
    this.publish({
      type: 'resized',
      terminalId: stored.terminalId,
      lease: cloneLease(stored),
      generation: stored.generation,
      observedAt: new Date(this.now()).toISOString()
    });
    return cloneLease(stored);
  }

  current(terminalId: string): TerminalInputLease | null {
    const current = this.active(requiredIdentity(terminalId, 'Terminal'));
    return current ? cloneLease(current) : null;
  }

  affinity(terminalId: string): {
    controllerDeviceId: string;
    controllerDeviceName: string;
  } | null {
    const affinity = this.affinities.get(requiredIdentity(terminalId, 'Terminal'));
    return affinity ? { ...affinity } : null;
  }

  park(terminalId: string, proof: TerminalControlProof): boolean {
    const terminal = requiredIdentity(terminalId, 'Terminal');
    const current = this.active(terminal);
    if (!current || !sameControl(current, proof)) return false;
    this.affinities.set(terminal, {
      controllerDeviceId: current.controllerDeviceId,
      controllerDeviceName: current.controllerDeviceName
    });
    return this.release(terminal, proof);
  }

  release(terminalId: string, proof: TerminalControlProof): boolean {
    const terminal = requiredIdentity(terminalId, 'Terminal');
    const current = this.active(terminal);
    if (!current || !sameControl(current, proof)) return false;
    this.leases.delete(terminal);
    this.publish({
      type: 'released',
      terminalId: terminal,
      lease: null,
      generation: current.generation,
      previousControllerDeviceId: current.controllerDeviceId,
      observedAt: new Date(this.now()).toISOString()
    });
    return true;
  }

  releaseTransportClient(_transportClientId: string): number {
    // Session Control belongs to a durable Soloe Device, not a transport connection.
    return 0;
  }

  clearTerminal(terminalId: string): boolean {
    const terminal = requiredIdentity(terminalId, 'Terminal');
    const current = this.leases.get(terminal);
    if (!current) return false;
    this.leases.delete(terminal);
    this.affinities.delete(terminal);
    this.publish({
      type: 'released',
      terminalId: terminal,
      lease: null,
      generation: current.generation,
      previousControllerDeviceId: current.controllerDeviceId,
      observedAt: new Date(this.now()).toISOString()
    });
    return true;
  }

  clear(): void {
    for (const terminalId of [...this.leases.keys()]) this.clearTerminal(terminalId);
    this.affinities.clear();
  }

  private active(terminalId: string): TerminalInputLease | null {
    return this.leases.get(terminalId) ?? null;
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

function sameControl(lease: TerminalInputLease, proof: TerminalControlProof): boolean {
  return lease.sessionId === proof.sessionId
    && lease.ownerDeviceId === proof.ownerDeviceId
    && lease.controllerDeviceId === proof.controllerDeviceId
    && lease.leaseId === proof.leaseId;
}

function ownedError(lease: TerminalInputLease): TerminalInputLeaseError {
  return new TerminalInputLeaseError(
    'terminal_input_owned',
    `Terminal input is controlled by ${lease.controllerDeviceName}.`,
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

function terminalDimension(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 10_000) {
    throw new Error(`Terminal ${label} must be an integer between 1 and 10000.`);
  }
  return result;
}
