import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@shared/types/sessions.js';
import type { CheckoutRecord } from '@shared/types/workspaces.js';
import { CheckoutLossScanner } from './CheckoutLossScanner.js';

const CHECKOUT_ID = '11111111-1111-4111-8111-111111111111';
const REPOSITORY_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const BRANCH_REF = 'refs/heads/soloe/session/owner-test';

describe('CheckoutLossScanner', () => {
  it('allows only a clean, published, archived-owner isolated Checkout with no other activity', async () => {
    const scanner = createScanner();

    const report = await scanner.scan(CHECKOUT_ID);

    expect(report).toMatchObject({
      checkoutId: CHECKOUT_ID,
      checkoutVersion: 2,
      eligible: true,
      blockers: [],
      activeConsumerSessionIds: [],
      activeOperationIds: []
    });
  });

  it.each([
    ['uncertain Git evidence', { evidence: { certain: false } }, 'uncertain'],
    ['staged work', { evidence: { staged: 1 } }, 'staged'],
    ['unstaged work', { evidence: { unstaged: 1 } }, 'unstaged'],
    ['untracked work', { evidence: { untracked: 1 } }, 'untracked'],
    ['ignored work', { evidence: { ignored: 1 } }, 'ignored'],
    ['unpublished commits', { evidence: { unpublishedCommits: 1 } }, 'unpublished'],
    ['an active consumer', { ownerArchived: false }, 'consumer'],
    ['a manually changed Branch', { evidence: { branchRef: 'refs/heads/other' } }, 'branch'],
    ['another active operation', { activeOperationIds: ['operation-1'] }, 'operation']
  ])('blocks cleanup for %s', async (_label, override, expectedCode) => {
    const report = await createScanner(override).scan(CHECKOUT_ID);

    expect(report.eligible).toBe(false);
    expect(report.blockers.map((blocker) => blocker.code)).toContain(expectedCode);
  });
});

function createScanner(override: {
  evidence?: Record<string, unknown>;
  ownerArchived?: boolean;
  activeOperationIds?: string[];
  checkout?: Partial<CheckoutRecord>;
} = {}) {
  const checkout: CheckoutRecord = {
    id: CHECKOUT_ID,
    repositoryId: REPOSITORY_ID,
    path: '/managed/isolated',
    runMode: 'linux',
    role: 'isolated-session',
    ownerSessionId: OWNER_ID,
    lifecycle: 'ready',
    version: 2,
    createdAt: '2026-08-12T12:00:00.000Z',
    updatedAt: '2026-08-12T12:00:00.000Z',
    ...override.checkout
  };
  const owner = {
    id: OWNER_ID,
    name: 'Owner',
    cwd: checkout.path,
    runMode: 'linux',
    launch: { type: 'terminal', shell: 'auto' },
    source: {
      kind: 'isolated-worktree',
      checkoutId: CHECKOUT_ID,
      base: { oid: '0123456789012345678901234567890123456789' },
      generatedBranch: BRANCH_REF,
      ownership: 'session'
    },
    createdAt: '2026-08-12T12:00:00.000Z',
    lastUsedAt: '2026-08-12T12:00:00.000Z',
    ...(override.ownerArchived === false ? {} : { archivedAt: '2026-08-12T12:05:00.000Z' })
  } as Session;
  return new CheckoutLossScanner({
    workspace: {
      snapshot: () => ({
        schemaVersion: 1,
        revision: 3,
        deviceId: '44444444-4444-4444-8444-444444444444',
        repositories: [],
        checkouts: [checkout]
      })
    },
    git: {
      scanCheckoutLoss: vi.fn(async () => ({
        certain: true,
        observedAt: '2026-08-12T12:10:00.000Z',
        headOid: '0123456789012345678901234567890123456789',
        branchRef: BRANCH_REF,
        detached: false,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        ignored: 0,
        unpublishedCommits: 0,
        ...override.evidence
      }))
    },
    listSessions: async () => [owner],
    listActiveOperationIds: () => override.activeOperationIds ?? []
  });
}
