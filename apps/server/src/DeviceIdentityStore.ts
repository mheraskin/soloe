import { randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';

import { isDeviceId, type DeviceId } from '@shared/types/devices.js';

const DEVICE_IDENTITY_FILE = 'device-identity.json';
const MAX_DEVICE_IDENTITY_BYTES = 4 * 1024;

export interface DeviceIdentity {
  version: 1;
  deviceId: DeviceId;
  createdAt: string;
}

export interface DeviceIdentityStoreOptions {
  createId?: () => string;
  now?: () => Date;
}

export class DeviceIdentityStore {
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly dataDirectory: string,
    options: DeviceIdentityStoreOptions = {}
  ) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  get filePath(): string {
    return path.join(this.dataDirectory, DEVICE_IDENTITY_FILE);
  }

  async loadOrCreate(): Promise<DeviceIdentity> {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      return await this.readExisting();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const identity = this.createIdentity();
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    try {
      await link(temporary, this.filePath);
      return identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return await this.readExisting();
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private createIdentity(): DeviceIdentity {
    const deviceId = this.createId();
    if (!isDeviceId(deviceId)) {
      throw new Error('Device identity generator returned an invalid UUID.');
    }
    const createdAt = this.now().toISOString();
    if (!Number.isFinite(Date.parse(createdAt))) {
      throw new Error('Device identity clock returned an invalid timestamp.');
    }
    return { version: 1, deviceId, createdAt };
  }

  private async readExisting(): Promise<DeviceIdentity> {
    const metadata = await stat(this.filePath);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_DEVICE_IDENTITY_BYTES) {
      throw corruptIdentity();
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw corruptIdentity();
    }
    if (!isRecord(value) || value['version'] !== 1 || !isDeviceId(value['deviceId'])) {
      throw corruptIdentity();
    }
    if (
      typeof value['createdAt'] !== 'string'
      || !value['createdAt'].trim()
      || !Number.isFinite(Date.parse(value['createdAt']))
    ) {
      throw corruptIdentity();
    }
    return {
      version: 1,
      deviceId: value['deviceId'],
      createdAt: value['createdAt']
    };
  }
}

export class DeviceIdentityCorruptError extends Error {
  readonly code = 'device_identity_corrupt';
  readonly remediation = 'Restore device-identity.json from backup or explicitly reset this Device identity.';

  constructor() {
    super('The durable Soloe Device identity is corrupt. Refusing to create a replacement identity.');
    this.name = 'DeviceIdentityCorruptError';
  }
}

function corruptIdentity(): DeviceIdentityCorruptError {
  return new DeviceIdentityCorruptError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
