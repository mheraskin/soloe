import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  DeviceCommandEnvelope,
  DeviceOperationReceipt
} from '@shared/types/commands.js';
import { isDeviceId, type DeviceId } from '@shared/types/devices.js';

const DEFAULT_MAX_RECEIPTS = 1_000;

interface PersistedOperationState {
  schemaVersion: 1;
  deviceId: DeviceId;
  receipts: DeviceOperationReceipt[];
}

export interface DeviceOperationStoreOptions {
  now?: () => Date;
  maxReceipts?: number;
}

export class DeviceOperationStore {
  private state: PersistedOperationState;
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly maxReceipts: number;

  constructor(
    private readonly filePath: string,
    readonly deviceId: DeviceId,
    options: DeviceOperationStoreOptions = {}
  ) {
    if (!isDeviceId(deviceId)) throw new Error('Device Operation Store requires a UUID Device ID.');
    this.state = { schemaVersion: 1, deviceId, receipts: [] };
    this.now = options.now ?? (() => new Date());
    this.maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
    if (!Number.isSafeInteger(this.maxReceipts) || this.maxReceipts < 1) {
      throw new Error('Device Operation receipt limit is invalid.');
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.state = parseState(JSON.parse(await fs.readFile(this.filePath, 'utf8')), this.deviceId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.writeState(this.state);
    }
    let changed = false;
    const timestamp = this.now().toISOString();
    for (const receipt of this.state.receipts) {
      if (receipt.state !== 'running' && receipt.state !== 'accepted') continue;
      receipt.state = 'interrupted';
      receipt.updatedAt = timestamp;
      receipt.error = {
        code: 'server_restarted',
        message: 'The Device Application Server restarted before the command outcome was recorded.'
      };
      changed = true;
    }
    if (changed) await this.writeState(this.state);
    this.initialized = true;
  }

  get(clientId: string, commandId: string): DeviceOperationReceipt | null {
    this.assertInitialized();
    const receipt = this.state.receipts.find((candidate) =>
      candidate.clientId === clientId && candidate.commandId === commandId
    );
    return receipt ? structuredClone(receipt) : null;
  }

  execute<TResult>(
    command: DeviceCommandEnvelope,
    kind: string,
    effect: () => Promise<TResult>
  ): Promise<DeviceOperationReceipt<TResult>> {
    const operation = this.queue.then(() => this.executeNow(command, kind, effect));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async executeNow<TResult>(
    command: DeviceCommandEnvelope,
    kind: string,
    effect: () => Promise<TResult>
  ): Promise<DeviceOperationReceipt<TResult>> {
    this.assertInitialized();
    validateCommand(command, this.deviceId);
    const operationKind = requiredToken(kind, 'operation kind');
    const intentDigest = digestIntent(command.intent);
    const previous = this.state.receipts.find((candidate) =>
      candidate.clientId === command.clientId && candidate.commandId === command.commandId
    );
    if (previous) {
      if (previous.intentDigest !== intentDigest || previous.kind !== operationKind) {
        throw new DeviceOperationConflictError(command.clientId, command.commandId);
      }
      if (previous.state === 'succeeded') {
        return structuredClone(previous) as DeviceOperationReceipt<TResult>;
      }
      throw new DeviceOperationOutcomeError(previous);
    }

    const timestamp = this.now().toISOString();
    const receipt: DeviceOperationReceipt<TResult> = {
      schemaVersion: 1,
      clientId: command.clientId,
      commandId: command.commandId,
      targetDeviceId: this.deviceId,
      kind: operationKind,
      intentDigest,
      state: 'running',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.state.receipts.push(receipt);
    this.trim();
    await this.writeState(this.state);
    try {
      receipt.result = structuredClone(await effect());
      receipt.state = 'succeeded';
      receipt.updatedAt = this.now().toISOString();
      await this.writeState(this.state);
      return structuredClone(receipt);
    } catch (error) {
      receipt.state = 'failed';
      receipt.updatedAt = this.now().toISOString();
      receipt.error = {
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error)
      };
      await this.writeState(this.state);
      throw error;
    }
  }

  private trim(): void {
    if (this.state.receipts.length <= this.maxReceipts) return;
    const removable = this.state.receipts
      .filter((receipt) => ['succeeded', 'failed', 'cancelled'].includes(receipt.state))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const remove = new Set(
      removable.slice(0, this.state.receipts.length - this.maxReceipts)
        .map((receipt) => `${receipt.clientId}\0${receipt.commandId}`)
    );
    this.state.receipts = this.state.receipts.filter((receipt) =>
      !remove.has(`${receipt.clientId}\0${receipt.commandId}`)
    );
    if (this.state.receipts.length > this.maxReceipts) {
      throw new Error('Device Operation journal is full of unfinished receipts.');
    }
  }

  private async writeState(state: PersistedOperationState): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), {
      encoding: 'utf8',
      flag: 'wx'
    });
    await fs.rename(temporary, this.filePath);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('Initialize the Device Operation Store before use.');
  }
}

export class DeviceOperationConflictError extends Error {
  readonly code = 'command_id_conflict';

  constructor(readonly clientId: string, readonly commandId: string) {
    super(`Command ${commandId} was already used with different intent by Client ${clientId}.`);
    this.name = 'DeviceOperationConflictError';
  }
}

export class DeviceOperationOutcomeError extends Error {
  readonly code = 'command_outcome_requires_inspection';

  constructor(readonly receipt: DeviceOperationReceipt) {
    super(`Command ${receipt.commandId} is ${receipt.state}; inspect its receipt before retrying.`);
    this.name = 'DeviceOperationOutcomeError';
  }
}

function validateCommand(command: DeviceCommandEnvelope, deviceId: DeviceId): void {
  if (
    !command
    || command.schemaVersion !== 1
    || !isDeviceId(command.clientId)
    || !isDeviceId(command.commandId)
    || command.targetDeviceId !== deviceId
    || !requiredToken(command.actorClientId, 'actor client ID')
    || !requiredToken(command.capabilityRevision, 'capability revision')
    || !requiredToken(command.planToken, 'plan token')
    || typeof command.expectedEntityVersions !== 'object'
    || command.expectedEntityVersions === null
    || !Number.isFinite(Date.parse(command.planExpiresAt))
  ) throw new Error('Device command envelope is invalid.');
}

function digestIntent(intent: unknown): string {
  return createHash('sha256').update(stableJson(intent)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Device command intent is not serializable.');
  return encoded;
}

function requiredToken(value: string, label: string): string {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token || token.length > 512 || /[\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error(`Device command ${label} is invalid.`);
  }
  return token;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'command_failed';
}

function parseState(value: unknown, deviceId: DeviceId): PersistedOperationState {
  if (!isRecord(value) || value['schemaVersion'] !== 1 || value['deviceId'] !== deviceId) {
    throw new Error('Device Operation journal is invalid.');
  }
  if (!Array.isArray(value['receipts']) || value['receipts'].length > 100_000) {
    throw new Error('Device Operation journal is invalid.');
  }
  for (const receipt of value['receipts']) validateReceipt(receipt, deviceId);
  return structuredClone(value) as unknown as PersistedOperationState;
}

function validateReceipt(value: unknown, deviceId: DeviceId): void {
  if (
    !isRecord(value)
    || value['schemaVersion'] !== 1
    || !isDeviceId(value['clientId'])
    || !isDeviceId(value['commandId'])
    || value['targetDeviceId'] !== deviceId
    || typeof value['kind'] !== 'string'
    || typeof value['intentDigest'] !== 'string'
    || !['planned', 'accepted', 'running', 'needs-attention', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(value['state']))
    || typeof value['createdAt'] !== 'string'
    || typeof value['updatedAt'] !== 'string'
  ) throw new Error('Device Operation journal contains an invalid receipt.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
