import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceDescriptorService } from './DeviceDescriptorService.js';
import {
  DeviceIdentityCorruptError,
  DeviceIdentityStore
} from './DeviceIdentityStore.js';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

describe('DeviceIdentityStore', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('keeps the same durable Device ID across server restarts and renames', async () => {
    const directory = await temporaryDirectory();
    const first = await new DeviceIdentityStore(directory, {
      createId: () => FIRST_ID,
      now: () => new Date('2026-08-12T10:00:00.000Z')
    }).loadOrCreate();
    const secondGenerator = vi.fn(() => SECOND_ID);
    const restarted = await new DeviceIdentityStore(directory, {
      createId: secondGenerator
    }).loadOrCreate();

    expect(restarted).toEqual(first);
    expect(secondGenerator).not.toHaveBeenCalled();
    const renamedDescriptor = new DeviceDescriptorService({
      deviceId: restarted.deviceId,
      deviceName: 'Renamed Device',
      nodePlatform: 'darwin',
      serverEpoch: SECOND_ID
    }).describe();
    expect(renamedDescriptor).toMatchObject({
      deviceId: FIRST_ID,
      name: 'Renamed Device',
      serverEpoch: SECOND_ID
    });
    expect(JSON.parse(await readFile(path.join(directory, 'device-identity.json'), 'utf8')))
      .toEqual(first);
  });

  it('atomically converges concurrent creators on one identity', async () => {
    const directory = await temporaryDirectory();
    const [first, second] = await Promise.all([
      new DeviceIdentityStore(directory, { createId: () => FIRST_ID }).loadOrCreate(),
      new DeviceIdentityStore(directory, { createId: () => SECOND_ID }).loadOrCreate()
    ]);
    expect(second.deviceId).toBe(first.deviceId);
    expect([FIRST_ID, SECOND_ID]).toContain(first.deviceId);
  });

  it('fails closed instead of silently replacing a corrupt identity', async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, 'device-identity.json');
    await writeFile(file, '{"version":1,"deviceId":"truncated"', 'utf8');
    if (process.platform !== 'win32') await chmod(file, 0o600);
    const createId = vi.fn(() => FIRST_ID);

    await expect(new DeviceIdentityStore(directory, { createId }).loadOrCreate())
      .rejects.toBeInstanceOf(DeviceIdentityCorruptError);
    expect(createId).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toContain('truncated');
  });

  async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-device-identity-'));
    directories.push(directory);
    return directory;
  }
});
