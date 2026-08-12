import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  CockpitPreferencesSnapshot,
  CockpitPreferencesUpdate
} from '@shared/types/cockpit.js';
import { isDeviceId, type DeviceId } from '@shared/types/devices.js';

export class CockpitPreferenceStore {
  private snapshot: CockpitPreferencesSnapshot = freshPreferences();
  private initRequest: Promise<void> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  init(): Promise<void> {
    this.initRequest ??= this.initialize();
    return this.initRequest;
  }

  get(): CockpitPreferencesSnapshot {
    return clonePreferences(this.snapshot);
  }

  async update(update: CockpitPreferencesUpdate): Promise<CockpitPreferencesSnapshot> {
    await this.init();
    const filterDeviceIds = update.filterDeviceIds === undefined
      ? this.snapshot.filterDeviceIds
      : parseDeviceIds(update.filterDeviceIds);
    const defaultPlacementDeviceId = update.defaultPlacementDeviceId === undefined
      ? this.snapshot.defaultPlacementDeviceId
      : update.defaultPlacementDeviceId === null
        ? null
        : requiredDeviceId(update.defaultPlacementDeviceId);
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      filterDeviceIds,
      defaultPlacementDeviceId
    };
    await this.persist();
    return this.get();
  }

  private async initialize(): Promise<void> {
    try {
      const source = await fs.readFile(this.filePath, 'utf8');
      const parsed = parsePreferences(JSON.parse(source));
      if (!parsed) throw new Error('Cockpit preferences are invalid.');
      this.snapshot = parsed;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.persist();
  }

  private persist(): Promise<void> {
    const value = JSON.stringify(this.snapshot, null, 2);
    const write = this.persistQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, value, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, this.filePath);
    });
    this.persistQueue = write.catch(() => undefined);
    return write;
  }
}
function freshPreferences(): CockpitPreferencesSnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    cockpitId: randomUUID(),
    filterDeviceIds: [],
    defaultPlacementDeviceId: null
  };
}

function parsePreferences(value: unknown): CockpitPreferencesSnapshot | null {
  if (!isRecord(value) || value['schemaVersion'] !== 1) return null;
  if (!Number.isSafeInteger(value['revision']) || (value['revision'] as number) < 0) return null;
  if (!isDeviceId(value['cockpitId'])) return null;
  if (!Array.isArray(value['filterDeviceIds'])) return null;
  const filterDeviceIds = parseDeviceIds(value['filterDeviceIds']);
  const defaultPlacementDeviceId = value['defaultPlacementDeviceId'] === null
    ? null
    : isDeviceId(value['defaultPlacementDeviceId'])
      ? value['defaultPlacementDeviceId']
      : undefined;
  if (defaultPlacementDeviceId === undefined) return null;
  return {
    schemaVersion: 1,
    revision: value['revision'] as number,
    cockpitId: value['cockpitId'],
    filterDeviceIds,
    defaultPlacementDeviceId
  };
}

function parseDeviceIds(values: unknown[]): DeviceId[] {
  const result: DeviceId[] = [];
  for (const value of values) {
    const deviceId = requiredDeviceId(value);
    if (!result.includes(deviceId)) result.push(deviceId);
  }
  return result;
}

function requiredDeviceId(value: unknown): DeviceId {
  if (!isDeviceId(value)) throw new Error('Cockpit preference contains an invalid Device ID.');
  return value;
}

function clonePreferences(value: CockpitPreferencesSnapshot): CockpitPreferencesSnapshot {
  return { ...value, filterDeviceIds: [...value.filterDeviceIds] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
