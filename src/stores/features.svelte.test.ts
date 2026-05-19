/**
 * @vitest-environment jsdom
 */
import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ipc', () => ({
  ipc: {
    features: {
      scan: vi.fn(async (request: { cwd: string; slug?: string }) => ({
        cwd: request.cwd,
        features: [],
        selectedSlug: request.slug ?? null,
        coverage: null,
        plans: [],
        issues: [],
        tracker: { provider: 'unknown', excerpt: null },
        setup: { hasAgentSkillsBlock: true, inFile: 'AGENTS.md' },
        scannedAt: 1
      })),
      setBranchStatus: vi.fn(),
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      onChange: vi.fn(() => () => undefined)
    }
  }
}));

import { featuresStore } from './features.svelte';

describe('featuresStore', () => {
  it('can refresh from an effect without tracking its own state patches', () => {
    const cwd = `/repo-${crypto.randomUUID()}`;

    const cleanup = $effect.root(() => {
      $effect(() => {
        featuresStore.setContext(cwd, { runMode: 'windows' });
        void featuresStore.refresh(cwd);
      });

      expect(() => flushSync()).not.toThrow();
    });

    cleanup();
  });
});
