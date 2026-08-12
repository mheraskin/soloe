import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CockpitPreferenceStore } from './CockpitPreferenceStore.js';

const ALPHA = '11111111-1111-4111-8111-111111111111';
const BETA = '22222222-2222-4222-8222-222222222222';

describe('CockpitPreferenceStore', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('preserves Cockpit identity and Device view choices across restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-cockpit-preferences-'));
    directories.push(directory);
    const filePath = path.join(directory, 'cockpit-preferences.json');
    const first = new CockpitPreferenceStore(filePath);
    await first.init();
    const initial = first.get();

    const updated = await first.update({
      filterDeviceIds: [BETA, ALPHA, BETA],
      defaultPlacementDeviceId: BETA
    });
    const restarted = new CockpitPreferenceStore(filePath);
    await restarted.init();

    expect(restarted.get()).toEqual({
      schemaVersion: 1,
      revision: updated.revision,
      cockpitId: initial.cockpitId,
      filterDeviceIds: [BETA, ALPHA],
      defaultPlacementDeviceId: BETA
    });
  });
});
