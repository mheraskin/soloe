import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceOperationStore } from '../../workspaces/DeviceOperationStore.js';
import { GitHubProviderService } from './GitHubProviderService.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = '33333333-3333-4333-8333-333333333333';

describe('GitHubProviderService', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('previews explicit visibility, detects conflicts, and creates idempotently', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-github-provider-'));
    directories.push(directory);
    const operations = new DeviceOperationStore(path.join(directory, 'operations.json'), DEVICE_ID);
    await operations.init();
    const adapter = {
      status: vi.fn(async () => ({ available: true, authenticated: true, login: 'mhera' })),
      listOwners: vi.fn(async () => [
        { login: 'mhera', kind: 'user' as const },
        { login: 'acme', kind: 'organization' as const }
      ]),
      repositoryExists: vi.fn(async (_owner: string, name: string) => name === 'taken'),
      createRepository: vi.fn(async (intent) => ({
        provider: 'github' as const,
        providerRepositoryId: 'R_123',
        owner: intent.owner,
        name: intent.name,
        visibility: intent.visibility,
        url: `https://github.com/${intent.owner}/${intent.name}`,
        sshUrl: `git@github.com:${intent.owner}/${intent.name}.git`
      }))
    };
    const service = new GitHubProviderService({
      deviceId: DEVICE_ID,
      capabilityRevision: 'github-v1',
      operations,
      adapter,
      now: () => new Date('2026-08-12T12:00:00.000Z')
    });
    const conflict = await service.plan({
      kind: 'create-github-repository',
      owner: 'acme',
      name: 'taken',
      visibility: 'private'
    });
    expect(conflict).toMatchObject({ executable: false, blockers: [expect.stringContaining('exists')] });

    const plan = await service.plan({
      kind: 'create-github-repository',
      owner: 'acme',
      name: 'compiler',
      visibility: 'private'
    });
    const command = {
      schemaVersion: 1 as const,
      clientId: CLIENT_ID,
      commandId: COMMAND_ID,
      targetDeviceId: DEVICE_ID,
      actorClientId: 'test-client',
      expectedEntityVersions: {},
      capabilityRevision: plan.capabilityRevision,
      planToken: plan.planToken,
      planExpiresAt: plan.expiresAt,
      intent: plan.intent
    };
    const first = await service.execute(command);
    const retried = await service.execute(command);

    expect(plan.preview.visibility).toBe('private');
    expect(first).toEqual(retried);
    expect(first).toMatchObject({
      state: 'succeeded',
      result: { owner: 'acme', name: 'compiler', visibility: 'private' }
    });
    expect(adapter.createRepository).toHaveBeenCalledTimes(1);
  });
});
