import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CockpitOperationStore } from './CockpitOperationStore.js';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_ID = '22222222-2222-4222-8222-222222222222';

describe('CockpitOperationStore', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('durably records child commands and marks unfinished sagas interrupted on restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-cockpit-operations-'));
    directories.push(directory);
    const filePath = path.join(directory, 'operations.json');
    const first = new CockpitOperationStore(filePath, {
      now: () => new Date('2026-08-12T12:00:00.000Z')
    });
    await first.init();
    await first.create({
      operationId: OPERATION_ID,
      planId: PLAN_ID,
      kind: 'place-session'
    });
    await first.update(OPERATION_ID, {
      state: 'running',
      phase: 'prepare-checkout',
      progress: 35,
      message: 'Preparing Checkout',
      childCommands: [{
        deviceId: '33333333-3333-4333-8333-333333333333',
        commandId: '44444444-4444-4444-8444-444444444444'
      }]
    });

    const restarted = new CockpitOperationStore(filePath, {
      now: () => new Date('2026-08-12T12:05:00.000Z')
    });
    await restarted.init();

    expect(restarted.get(OPERATION_ID)).toMatchObject({
      kind: 'place-session',
      state: 'interrupted',
      phase: 'recover',
      progress: 35,
      childCommands: [{ commandId: '44444444-4444-4444-8444-444444444444' }]
    });
    expect(restarted.listRecoverable()).toHaveLength(1);
  });
});
