/**
 * @vitest-environment jsdom
 */
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
        artifactRevision: 'mock-revision',
        scannedAt: 1
      })),
      setBranchStatus: vi.fn(),
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      onChange: vi.fn(() => () => undefined)
    }
  }
}));

import { createFeatureScope, featuresStore } from './features.svelte';
import { ipc } from '../lib/ipc';

afterEach(() => {
  vi.mocked(ipc.features.subscribe).mockReset().mockResolvedValue(true);
  vi.mocked(ipc.features.unsubscribe).mockReset().mockResolvedValue(true);
});

describe('featuresStore', () => {
  it('can refresh from an effect without tracking its own state patches', () => {
    const cwd = `/repo-${crypto.randomUUID()}`;
    const scope = createFeatureScope(cwd, { runMode: 'windows' });

    const cleanup = $effect.root(() => {
      $effect(() => {
        void featuresStore.refresh(scope);
      });

      expect(() => flushSync()).not.toThrow();
    });

    cleanup();
  });

  it('releases a subscription when the pane unmounts before subscribe resolves', async () => {
    const cwd = `/repo-${crypto.randomUUID()}`;
    const scope = createFeatureScope(cwd, { runMode: 'windows' });
    const pending = deferred<true>();
    vi.mocked(ipc.features.subscribe).mockReturnValueOnce(pending.promise);
    const mounting = featuresStore.subscribe(scope);
    const unmounting = featuresStore.unsubscribe(scope);
    pending.resolve(true);
    await Promise.all([mounting, unmounting]);

    // The serialized reconciler may cancel both calls before the subscribe is
    // sent. If it has already crossed IPC, it must send the matching release.
    expect(ipc.features.unsubscribe).toHaveBeenCalledTimes(
      vi.mocked(ipc.features.subscribe).mock.calls.length
    );
    expect(ipc.features.subscribe).toHaveBeenCalledTimes(0);
  });

  it('keeps the main subscription until the final renderer owner releases it', async () => {
    const cwd = `/repo-${crypto.randomUUID()}`;
    const scope = createFeatureScope(cwd, { runMode: 'windows' });

    await featuresStore.subscribe(scope);
    await featuresStore.subscribe(scope);
    expect(ipc.features.subscribe).toHaveBeenCalledTimes(1);

    await featuresStore.unsubscribe(scope);
    expect(ipc.features.unsubscribe).not.toHaveBeenCalled();

    await featuresStore.unsubscribe(scope);
    expect(ipc.features.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('owns equal-path subscriptions independently across WSL distributions', async () => {
    const cwd = `/repo-${crypto.randomUUID()}`;
    const ubuntu = createFeatureScope(cwd, { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const debian = createFeatureScope(cwd, { runMode: 'wsl', wslDistro: 'Debian' });
    await featuresStore.subscribe(ubuntu);
    await featuresStore.subscribe(debian);

    expect(ipc.features.subscribe).toHaveBeenCalledWith({
      cwd,
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    });
    expect(ipc.features.subscribe).toHaveBeenCalledWith({
      cwd,
      runMode: 'wsl',
      wslDistro: 'Debian'
    });

    await featuresStore.unsubscribe(ubuntu);
    expect(ipc.features.unsubscribe).toHaveBeenCalledWith({
      cwd,
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    });
    expect(ipc.features.unsubscribe).not.toHaveBeenCalledWith({
      cwd,
      runMode: 'wsl',
      wslDistro: 'Debian'
    });
    await featuresStore.unsubscribe(debian);
  });

  it('isolates reverse-order same-path scans and routes change events by runtime', async () => {
    const cwd = `/repo-${crypto.randomUUID()}`;
    const ubuntu = createFeatureScope(cwd, { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const debian = createFeatureScope(cwd, { runMode: 'wsl', wslDistro: 'Debian' });
    const ubuntuScan = deferred<Awaited<ReturnType<typeof ipc.features.scan>>>();
    const debianScan = deferred<Awaited<ReturnType<typeof ipc.features.scan>>>();
    vi.mocked(ipc.features.scan).mockImplementationOnce((request) =>
      request.wslDistro === 'Ubuntu' ? ubuntuScan.promise : debianScan.promise
    ).mockImplementationOnce((request) =>
      request.wslDistro === 'Ubuntu' ? ubuntuScan.promise : debianScan.promise
    );

    const ubuntuLoad = featuresStore.refresh(ubuntu);
    const debianLoad = featuresStore.refresh(debian);
    debianScan.resolve(snapshot(cwd, 2));
    await debianLoad;
    ubuntuScan.resolve(snapshot(cwd, 1));
    await ubuntuLoad;

    expect(featuresStore.stateFor(ubuntu)?.snapshot?.scannedAt).toBe(1);
    expect(featuresStore.stateFor(debian)?.snapshot?.scannedAt).toBe(2);

    vi.mocked(ipc.features.scan).mockClear().mockResolvedValue(snapshot(cwd, 3));
    featuresStore.applyChangeEvent({
      cwd,
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      kind: 'features',
      revision: 'revision-3'
    });
    await vi.waitFor(() => expect(ipc.features.scan).toHaveBeenCalledTimes(1));
    expect(ipc.features.scan).toHaveBeenCalledWith(expect.objectContaining({
      cwd,
      wslDistro: 'Ubuntu',
      observedRevision: 'revision-3'
    }));
  });
});

function snapshot(cwd: string, scannedAt: number): Awaited<ReturnType<typeof ipc.features.scan>> {
  return {
    cwd,
    features: [],
    selectedSlug: null,
    coverage: null,
    plans: [],
    issues: [],
    tracker: { provider: 'unknown', excerpt: null },
    setup: { hasAgentSkillsBlock: true, inFile: 'AGENTS.md' },
    artifactRevision: `revision-${scannedAt}`,
    scannedAt
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
