import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { CockpitOperation, OperationState } from '@shared/types/commands.js';
import { isDeviceId } from '@shared/types/devices.js';

interface PersistedCockpitOperations {
  schemaVersion: 1;
  operations: CockpitOperation[];
}

export interface CockpitOperationStoreOptions {
  now?: () => Date;
  maxOperations?: number;
}

type OperationPatch = Partial<Pick<
  CockpitOperation,
  'state' | 'phase' | 'progress' | 'message' | 'childCommands' | 'result'
>>;

export class CockpitOperationStore {
  private state: PersistedCockpitOperations = { schemaVersion: 1, operations: [] };
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly maxOperations: number;

  constructor(
    private readonly filePath: string,
    options: CockpitOperationStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxOperations = options.maxOperations ?? 1_000;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.state = parseState(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.write(this.state);
    }
    const timestamp = this.now().toISOString();
    let changed = false;
    for (const operation of this.state.operations) {
      if (!['accepted', 'running', 'needs-attention'].includes(operation.state)) continue;
      operation.state = 'interrupted';
      operation.phase = 'recover';
      operation.message = 'The Cockpit restarted before the operation outcome was settled.';
      operation.updatedAt = timestamp;
      changed = true;
    }
    if (changed) await this.write(this.state);
    this.initialized = true;
  }

  get(operationId: string): CockpitOperation | null {
    this.assertInitialized();
    const value = this.state.operations.find((operation) => operation.operationId === operationId);
    return value ? structuredClone(value) : null;
  }

  listRecoverable(): CockpitOperation[] {
    this.assertInitialized();
    return this.state.operations
      .filter((operation) => ['interrupted', 'needs-attention'].includes(operation.state))
      .map((operation) => structuredClone(operation));
  }

  create(input: { operationId: string; planId: string; kind: string }): Promise<CockpitOperation> {
    return this.enqueue(async () => {
      this.assertInitialized();
      if (!isDeviceId(input.operationId) || !isDeviceId(input.planId) || !input.kind.trim()) {
        throw new Error('Cockpit operation identity is invalid.');
      }
      const existing = this.state.operations.find((item) => item.operationId === input.operationId);
      if (existing) {
        if (existing.planId !== input.planId || existing.kind !== input.kind) {
          throw new Error(`Cockpit operation already exists: ${input.operationId}`);
        }
        return structuredClone(existing);
      }
      const timestamp = this.now().toISOString();
      const operation: CockpitOperation = {
        schemaVersion: 1,
        operationId: input.operationId,
        planId: input.planId,
        kind: input.kind.trim(),
        state: 'accepted',
        phase: 'accepted',
        progress: 0,
        message: 'Operation accepted.',
        childCommands: [],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      this.state.operations.push(operation);
      this.trim();
      await this.write(this.state);
      return structuredClone(operation);
    });
  }

  update(operationId: string, patch: OperationPatch): Promise<CockpitOperation> {
    return this.enqueue(async () => {
      this.assertInitialized();
      const operation = this.state.operations.find((item) => item.operationId === operationId);
      if (!operation) throw new Error(`Cockpit operation not found: ${operationId}`);
      if (patch.state !== undefined) validateState(patch.state);
      if (patch.progress !== undefined && (
        !Number.isFinite(patch.progress) || patch.progress < 0 || patch.progress > 100
      )) throw new Error('Cockpit operation progress is invalid.');
      Object.assign(operation, structuredClone(patch), { updatedAt: this.now().toISOString() });
      await this.write(this.state);
      return structuredClone(operation);
    });
  }

  private enqueue<T>(effect: () => Promise<T>): Promise<T> {
    const request = this.queue.then(effect);
    this.queue = request.catch(() => undefined);
    return request;
  }

  private trim(): void {
    if (this.state.operations.length <= this.maxOperations) return;
    const terminal = new Set<OperationState>(['succeeded', 'failed', 'cancelled']);
    const removable = this.state.operations
      .filter((operation) => terminal.has(operation.state))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const removeIds = new Set(
      removable.slice(0, this.state.operations.length - this.maxOperations)
        .map((operation) => operation.operationId)
    );
    this.state.operations = this.state.operations.filter(
      (operation) => !removeIds.has(operation.operationId)
    );
    if (this.state.operations.length > this.maxOperations) {
      throw new Error('Cockpit operation journal is full of unfinished operations.');
    }
  }

  private async write(state: PersistedCockpitOperations): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), {
      encoding: 'utf8',
      flag: 'wx'
    });
    await fs.rename(temporary, this.filePath);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('Initialize the Cockpit Operation Store before use.');
  }
}

function parseState(value: unknown): PersistedCockpitOperations {
  if (!isRecord(value) || value['schemaVersion'] !== 1 || !Array.isArray(value['operations'])) {
    throw new Error('Cockpit operation journal is invalid.');
  }
  for (const operation of value['operations']) validateOperation(operation);
  return structuredClone(value) as unknown as PersistedCockpitOperations;
}

function validateOperation(value: unknown): void {
  if (
    !isRecord(value)
    || value['schemaVersion'] !== 1
    || !isDeviceId(value['operationId'])
    || !isDeviceId(value['planId'])
    || typeof value['kind'] !== 'string'
    || typeof value['phase'] !== 'string'
    || typeof value['message'] !== 'string'
    || typeof value['progress'] !== 'number'
    || !Array.isArray(value['childCommands'])
    || typeof value['createdAt'] !== 'string'
    || typeof value['updatedAt'] !== 'string'
  ) throw new Error('Cockpit operation journal contains an invalid operation.');
  validateState(value['state']);
}

function validateState(value: unknown): asserts value is OperationState {
  if (![
    'planned', 'accepted', 'running', 'needs-attention', 'succeeded',
    'failed', 'cancelled', 'interrupted'
  ].includes(String(value))) throw new Error('Cockpit operation state is invalid.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
