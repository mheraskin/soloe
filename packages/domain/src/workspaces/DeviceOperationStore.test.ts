import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeviceCommandEnvelope } from '@shared/types/commands.js';
import { DeviceOperationConflictError, DeviceOperationStore } from './DeviceOperationStore.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = '33333333-3333-4333-8333-333333333333';

describe('DeviceOperationStore', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('returns a durable receipt for duplicate delivery without repeating effects', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-device-operations-'));
    directories.push(directory);
    const filePath = path.join(directory, 'operations.json');
    const effect = vi.fn(async () => ({ checkoutId: 'checkout-one' }));
    const firstStore = new DeviceOperationStore(filePath, DEVICE_ID, {
      now: () => new Date('2026-08-12T12:00:00.000Z')
    });
    await firstStore.init();

    const first = await firstStore.execute(command(), 'prepare-workspace-location', effect);
    const restarted = new DeviceOperationStore(filePath, DEVICE_ID);
    await restarted.init();
    const repeated = await restarted.execute(command(), 'prepare-workspace-location', effect);

    expect(first.state).toBe('succeeded');
    expect(repeated).toEqual(first);
    expect(effect).toHaveBeenCalledOnce();
    expect(restarted.get(CLIENT_ID, COMMAND_ID)).toEqual(first);
  });

  it('rejects command ID reuse with different intent', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-device-operations-'));
    directories.push(directory);
    const store = new DeviceOperationStore(path.join(directory, 'operations.json'), DEVICE_ID);
    await store.init();
    await store.execute(command(), 'prepare-workspace-location', async () => true);

    await expect(store.execute({
      ...command(),
      intent: { checkoutId: 'different' }
    }, 'prepare-workspace-location', async () => true)).rejects.toBeInstanceOf(
      DeviceOperationConflictError
    );
  });
});

function command(): DeviceCommandEnvelope<{ checkoutId: string }> {
  return {
    schemaVersion: 1,
    clientId: CLIENT_ID,
    commandId: COMMAND_ID,
    targetDeviceId: DEVICE_ID,
    actorClientId: 'test-client',
    expectedEntityVersions: {},
    capabilityRevision: 'workspace-v1',
    planToken: 'plan-token',
    planExpiresAt: '2026-08-12T13:00:00.000Z',
    intent: { checkoutId: 'checkout-one' }
  };
}
