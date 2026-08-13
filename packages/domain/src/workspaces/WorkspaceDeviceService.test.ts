import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { DeviceCommandEnvelope } from '@shared/types/commands.js';
import type {
  DeviceWorkspaceIntent,
  PrepareWorkspaceLocationIntent
} from '@shared/types/workspaces.js';
import type { Session } from '@shared/types/sessions.js';
import type { Project } from '@shared/types/projects.js';
import { GitService } from '../git/GitService.js';
import { DeviceOperationStore } from './DeviceOperationStore.js';
import { WorkspaceDeviceStore } from './WorkspaceDeviceStore.js';
import { WorkspaceDeviceService } from './WorkspaceDeviceService.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = '33333333-3333-4333-8333-333333333333';
const CHECKOUT_ID = '44444444-4444-4444-8444-444444444444';

describe('WorkspaceDeviceService', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('plans and idempotently prepares an existing Branch as a durable Checkout', async () => {
    const fixture = await createFixture();
    const targetPath = path.join(fixture.managedRoot, 'feature');
    const intent: PrepareWorkspaceLocationIntent = {
      kind: 'prepare-workspace-location',
      repositoryId: fixture.repositoryId,
      checkoutId: CHECKOUT_ID,
      path: targetPath,
      runMode: 'linux',
      source: { kind: 'branch', localRef: 'refs/heads/feature' }
    };
    const plan = await fixture.service.plan(intent);

    expect(plan).toMatchObject({
      executable: true,
      expectedWorkspaceRevision: fixture.workspace.snapshot().revision,
      preview: { targetPath, sourceLabel: 'refs/heads/feature' }
    });
    const envelope = command(plan, intent);
    const first = await fixture.service.execute(envelope);
    const repeated = await fixture.service.execute(envelope);

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      state: 'succeeded',
      result: { checkout: { id: CHECKOUT_ID, lifecycle: 'ready', role: 'workspace' } }
    });
    expect(git(fixture.repository, ['worktree', 'list', '--porcelain'])).toContain(targetPath);
  });

  it('blocks a Branch already checked out elsewhere and paths outside managed roots', async () => {
    const fixture = await createFixture();
    const occupied = path.join(fixture.managedRoot, 'occupied');
    git(fixture.repository, ['worktree', 'add', occupied, 'feature']);

    const conflict = await fixture.service.plan({
      kind: 'prepare-workspace-location',
      repositoryId: fixture.repositoryId,
      checkoutId: CHECKOUT_ID,
      path: path.join(fixture.managedRoot, 'other'),
      runMode: 'linux',
      source: { kind: 'branch', localRef: 'refs/heads/feature' }
    });
    expect(conflict).toMatchObject({ executable: false });
    expect(conflict.blockers.join(' ')).toContain('already checked out');

    await expect(fixture.service.plan({
      kind: 'prepare-workspace-location',
      repositoryId: fixture.repositoryId,
      checkoutId: '55555555-5555-4555-8555-555555555555',
      path: path.join(fixture.directory, 'escape'),
      runMode: 'linux',
      source: { kind: 'branch', localRef: 'refs/heads/main' }
    })).rejects.toThrow('managed root');
  });

  it('allocates a safe Device-managed path when the client does not know filesystem roots', async () => {
    const fixture = await createFixture();
    const intent = {
      kind: 'prepare-workspace-location',
      repositoryId: fixture.repositoryId,
      checkoutId: CHECKOUT_ID,
      runMode: 'linux',
      source: { kind: 'revision', oid: git(fixture.repository, ['rev-parse', 'HEAD']) }
    } as PrepareWorkspaceLocationIntent;

    const plan = await fixture.service.plan(intent);

    expect(plan.executable).toBe(true);
    expect(plan.intent.path).toBe(path.join(fixture.managedRoot, CHECKOUT_ID));
    expect(plan.preview.targetPath).toBe(path.join(fixture.managedRoot, CHECKOUT_ID));
  });

  it('clones a Project Presence directly on the Device with durable pending identities', async () => {
    const fixture = await createFixture();
    const bare = path.join(fixture.directory, 'remote.git');
    git(fixture.directory, ['clone', '--bare', fixture.repository, bare]);
    const repositoryId = '55555555-5555-4555-8555-555555555555';
    const checkoutId = '66666666-6666-4666-8666-666666666666';
    const intent = {
      kind: 'clone-project-presence' as const,
      repositoryId,
      checkoutId,
      sourceUrl: bare,
      runMode: 'linux' as const,
      branchRef: 'refs/heads/main',
      identity: { kind: 'git' as const, canonicalUrl: bare }
    };

    const plan = await fixture.service.plan(intent);
    const receipt = await fixture.service.execute({
      ...command(plan, plan.intent as PrepareWorkspaceLocationIntent),
      commandId: '77777777-7777-4777-8777-777777777777',
      intent: plan.intent
    });

    expect(receipt).toMatchObject({
      state: 'succeeded',
      result: {
        repository: { id: repositoryId },
        checkout: { id: checkoutId, lifecycle: 'ready', role: 'main' }
      }
    });
    expect(git(plan.preview.targetPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('prepares a Session-owned isolated Worktree on a generated Branch', async () => {
    const fixture = await createFixture();
    const baseOid = git(fixture.repository, ['rev-parse', 'HEAD']);
    const ownerSessionId = '88888888-8888-4888-8888-888888888888';
    const checkoutId = '99999999-9999-4999-8999-999999999999';
    const plan = await fixture.service.plan({
      kind: 'prepare-isolated-session-source',
      repositoryId: fixture.repositoryId,
      checkoutId,
      ownerSessionId,
      runMode: 'linux',
      baseOid,
      detached: false
    });

    expect(plan).toMatchObject({
      executable: true,
      intent: {
        branchRef: expect.stringMatching(/^refs\/heads\/soloe\/session\//u),
        path: path.join(fixture.managedRoot, checkoutId)
      }
    });
    const receipt = await fixture.service.execute({
      ...command(plan, plan.intent as PrepareWorkspaceLocationIntent),
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      intent: plan.intent
    });

    expect(receipt).toMatchObject({
      state: 'succeeded',
      result: {
        checkout: {
          id: checkoutId,
          role: 'isolated-session',
          ownerSessionId,
          lifecycle: 'ready'
        }
      }
    });
    expect(git(plan.preview.targetPath, ['rev-parse', '--abbrev-ref', 'HEAD']))
      .toContain('soloe/session/');
  });

  it('re-scans and removes an archived owner isolated Checkout without force', async () => {
    const fixture = await createFixture();
    const remote = path.join(fixture.directory, 'cleanup-remote.git');
    git(fixture.directory, ['clone', '--bare', fixture.repository, remote]);
    git(fixture.repository, ['remote', 'add', 'origin', remote]);
    git(fixture.repository, ['fetch', 'origin']);
    const baseOid = git(fixture.repository, ['rev-parse', 'HEAD']);
    const ownerSessionId = '88888888-8888-4888-8888-888888888888';
    const checkoutId = '99999999-9999-4999-8999-999999999999';
    const isolatedPlan = await fixture.service.plan({
      kind: 'prepare-isolated-session-source',
      repositoryId: fixture.repositoryId,
      checkoutId,
      ownerSessionId,
      runMode: 'linux',
      baseOid,
      detached: false
    });
    await fixture.service.execute(command(
      isolatedPlan,
      isolatedPlan.intent,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ));
    const isolatedIntent = isolatedPlan.intent.kind === 'prepare-isolated-session-source'
      ? isolatedPlan.intent
      : neverIntent();
    fixture.sessions.push(session({
      id: ownerSessionId,
      cwd: isolatedPlan.preview.targetPath,
      archivedAt: '2026-08-12T12:05:00.000Z',
      source: {
        kind: 'isolated-worktree',
        checkoutId,
        base: { oid: baseOid },
        generatedBranch: isolatedIntent.branchRef,
        ownership: 'session'
      }
    }));

    const cleanup = await fixture.service.plan({
      kind: 'cleanup-isolated-checkout',
      checkoutId,
      expectedOwnerSessionId: ownerSessionId
    });
    expect(cleanup).toMatchObject({ executable: true, lossReport: { eligible: true } });
    const receipt = await fixture.service.execute(command(
      cleanup,
      cleanup.intent,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    ));

    expect(receipt).toMatchObject({
      state: 'succeeded',
      result: { checkout: { id: checkoutId, lifecycle: 'removed' } }
    });
    expect(git(fixture.repository, ['worktree', 'list', '--porcelain']))
      .not.toContain(isolatedPlan.preview.targetPath);
  });

  it('promotes an isolated Checkout without deleting useful dirty or unpublished work', async () => {
    const fixture = await createFixture();
    const baseOid = git(fixture.repository, ['rev-parse', 'HEAD']);
    const ownerSessionId = '88888888-8888-4888-8888-888888888888';
    const checkoutId = '99999999-9999-4999-8999-999999999999';
    const isolatedPlan = await fixture.service.plan({
      kind: 'prepare-isolated-session-source',
      repositoryId: fixture.repositoryId,
      checkoutId,
      ownerSessionId,
      runMode: 'linux',
      baseOid,
      detached: false
    });
    await fixture.service.execute(command(
      isolatedPlan,
      isolatedPlan.intent,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ));
    const isolatedIntent = isolatedPlan.intent.kind === 'prepare-isolated-session-source'
      ? isolatedPlan.intent
      : neverIntent();
    fixture.sessions.push(session({
      id: ownerSessionId,
      cwd: isolatedPlan.preview.targetPath,
      source: {
        kind: 'isolated-worktree',
        checkoutId,
        base: { oid: baseOid },
        generatedBranch: isolatedIntent.branchRef,
        ownership: 'session'
      }
    }));
    await writeFile(path.join(isolatedPlan.preview.targetPath, 'useful.txt'), 'keep me\n', 'utf8');

    const promotion = await fixture.service.plan({
      kind: 'promote-isolated-checkout',
      checkoutId,
      expectedOwnerSessionId: ownerSessionId
    });
    expect(promotion).toMatchObject({
      executable: true,
      lossReport: { eligible: false }
    });
    const receipt = await fixture.service.execute(command(
      promotion,
      promotion.intent,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    ));

    expect(receipt).toMatchObject({
      state: 'succeeded',
      result: { checkout: { id: checkoutId, role: 'workspace' } }
    });
    expect((receipt.result as { checkout: { ownerSessionId?: string } }).checkout.ownerSessionId)
      .toBeUndefined();
  });

  it('plans journaled push and fetch-fast-forward alignment with immutable OID checks', async () => {
    const fixture = await createFixture();
    const remote = path.join(fixture.directory, 'alignment.git');
    git(fixture.directory, ['clone', '--bare', fixture.repository, remote]);
    git(fixture.repository, ['remote', 'add', 'origin', remote]);
    git(fixture.repository, ['fetch', 'origin']);
    const target = path.join(fixture.directory, 'alignment-target');
    git(fixture.directory, ['clone', remote, target]);
    const targetAdoption = await fixture.workspace.adoptLegacy({
      migrationKey: 'alignment-target-v1',
      projects: [project(target, 'target')],
      sessions: []
    });
    const targetCheckout = fixture.workspace.snapshot().checkouts.find((checkout) =>
      checkout.repositoryId === targetAdoption.projectRepositories.target
    );
    if (!targetCheckout) throw new Error('Target Checkout fixture is missing.');
    await writeFile(path.join(fixture.repository, 'aligned.txt'), 'aligned\n', 'utf8');
    git(fixture.repository, ['add', 'aligned.txt']);
    git(fixture.repository, ['commit', '-m', 'align me']);
    const sourceOid = git(fixture.repository, ['rev-parse', 'HEAD']);
    const targetOid = git(target, ['rev-parse', 'HEAD']);

    const push = await fixture.service.plan({
      kind: 'push-workspace-branch',
      checkoutId: fixture.mainCheckoutId,
      remote: 'origin',
      branchRef: 'refs/heads/main'
    });
    const fastForward = await fixture.service.plan({
      kind: 'fetch-fast-forward-workspace-branch',
      checkoutId: targetCheckout.id,
      remote: 'origin',
      branchRef: 'refs/heads/main',
      targetOid: sourceOid
    });
    expect(push).toMatchObject({
      executable: true,
      intent: { expectedLocalOid: sourceOid, expectedRemoteOid: targetOid }
    });
    expect(fastForward).toMatchObject({
      executable: true,
      intent: { expectedHeadOid: targetOid, expectedRemoteOid: sourceOid }
    });

    await fixture.service.execute(command(
      push,
      push.intent,
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    ));
    const receipt = await fixture.service.execute(command(
      fastForward,
      fastForward.intent,
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    ));

    expect(receipt).toMatchObject({ state: 'succeeded', result: { status: { head: sourceOid } } });
    expect(git(target, ['rev-parse', 'HEAD'])).toBe(sourceOid);
  });

  it('plans a new provider remote attachment and exact initial Branch publication', async () => {
    const fixture = await createFixture();
    const remote = path.join(fixture.directory, 'provider-created.git');
    git(fixture.directory, ['init', '--bare', remote]);
    const headOid = git(fixture.repository, ['rev-parse', 'HEAD']);

    const plan = await fixture.service.plan({
      kind: 'publish-new-remote-branch',
      checkoutId: fixture.mainCheckoutId,
      remote: 'origin',
      remoteUrl: remote,
      branchRef: 'refs/heads/main'
    });
    expect(plan).toMatchObject({
      executable: true,
      intent: { expectedLocalOid: headOid, remoteUrl: remote }
    });
    const receipt = await fixture.service.execute(command(
      plan,
      plan.intent,
      'ffffffff-ffff-4fff-8fff-ffffffffffff'
    ));

    expect(receipt).toMatchObject({
      state: 'succeeded',
      result: { evidence: { localOid: headOid, remoteOid: headOid } }
    });
  });
});

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-workspace-service-'));
  const repository = path.join(directory, 'repository');
  const managedRoot = path.join(directory, 'managed');
  await mkdir(managedRoot, { recursive: true });
  git(directory, ['init', '-b', 'main', repository]);
  git(repository, ['config', 'user.email', 'tests@soloe.local']);
  git(repository, ['config', 'user.name', 'Soloe Tests']);
  await writeFile(path.join(repository, 'README.md'), '# fixture\n', 'utf8');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'initial']);
  git(repository, ['branch', 'feature']);
  const workspace = new WorkspaceDeviceStore(path.join(directory, 'workspaces.json'), DEVICE_ID);
  await workspace.init();
  const adopted = await workspace.adoptLegacy({
    migrationKey: 'legacy-v1',
    projects: [project(repository)],
    sessions: []
  });
  const operations = new DeviceOperationStore(path.join(directory, 'operations.json'), DEVICE_ID);
  await operations.init();
  const gitService = new GitService({ gitBinary: 'git' });
  const sessions: Session[] = [];
  const service = new WorkspaceDeviceService({
    workspace,
    operations,
    git: gitService,
    managedRoots: [managedRoot],
    capabilityRevision: 'workspace-service-v1',
    listSessions: async () => structuredClone(sessions),
    now: () => new Date('2026-08-12T12:00:00.000Z')
  });
  return {
    directory,
    repository,
    managedRoot,
    workspace,
    sessions,
    service,
    repositoryId: adopted.projectRepositories.compiler!,
    mainCheckoutId: workspace.snapshot().checkouts.find((checkout) =>
      checkout.repositoryId === adopted.projectRepositories.compiler
      && checkout.role === 'main'
    )!.id
  };
}

function command(
  plan: Awaited<ReturnType<WorkspaceDeviceService['plan']>>,
  intent: DeviceWorkspaceIntent,
  commandId = COMMAND_ID
): DeviceCommandEnvelope<DeviceWorkspaceIntent> {
  return {
    schemaVersion: 1,
    clientId: CLIENT_ID,
    commandId,
    targetDeviceId: DEVICE_ID,
    actorClientId: 'test-client',
    expectedEntityVersions: { 'device-workspace': plan.expectedWorkspaceRevision },
    capabilityRevision: plan.capabilityRevision,
    planToken: plan.planToken,
    planExpiresAt: plan.expiresAt,
    intent
  };
}

function session(input: Pick<Session, 'id' | 'cwd' | 'source'> & { archivedAt?: string }): Session {
  return {
    id: input.id,
    version: 1,
    name: 'Isolated owner',
    cwd: input.cwd,
    runMode: 'linux',
    launch: { type: 'terminal', shell: 'auto' },
    source: input.source,
    createdAt: '2026-08-12T12:00:00.000Z',
    lastUsedAt: '2026-08-12T12:00:00.000Z',
    ...(input.archivedAt ? { archivedAt: input.archivedAt } : {})
  };
}

function neverIntent(): never {
  throw new Error('Unexpected test intent.');
}

function project(repository: string, id = 'compiler'): Project {
  return {
    id,
    name: 'Compiler',
    path: repository,
    defaultRunMode: 'linux',
    createdAt: '2026-08-12T12:00:00.000Z',
    lastOpenedAt: '2026-08-12T12:00:00.000Z'
  };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
