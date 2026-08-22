/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionSnapshot } from '@shared/types/connections.js';

const { refresh, onChange, off } = vi.hoisted(() => ({
  refresh: vi.fn(),
  onChange: vi.fn(),
  off: vi.fn()
}));

vi.mock('../lib/ipc', () => ({
  supportsBackendOperation: () => true,
  ipc: {
    connections: {
      get: vi.fn(),
      refresh,
      add: vi.fn(),
      remove: vi.fn(),
      setEnabled: vi.fn(),
      select: vi.fn(),
      onChange
    }
  }
}));

import { ConnectionsStore } from './connections.svelte.js';

const SNAPSHOT: ConnectionSnapshot = {
  activeId: 'local',
  machines: [{
    id: 'local',
    name: 'mbp.local',
    endpoint: null,
    endpointAliases: [],
    source: 'local',
    status: 'available',
    trust: 'local',
    enabled: true,
    active: true,
    isSelf: true,
    lastSeenAt: '2026-08-13T10:00:00.000Z'
  }],
  preferences: { tailscaleEnabled: true, tailscaleHttpsPort: 443 },
  tailscale: {
    state: 'connected',
    tailnet: 'example.com',
    selfDnsName: 'client.tail1234.ts.net',
    message: null,
    sharing: { state: 'ready', message: null, setupUrl: null }
  },
  shortDns: {
    state: 'ready',
    zone: 'client',
    nameserver: '100.64.0.1',
    message: null,
    setupUrl: null,
    readyZones: ['client']
  },
  refreshedAt: '2026-08-13T10:00:00.000Z'
};

describe('ConnectionsStore discovery lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    refresh.mockResolvedValue(SNAPSHOT);
    onChange.mockReturnValue(off);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('discovers while the desktop client is attached and stops after detach', async () => {
    const store = new ConnectionsStore();
    store.attachListeners();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledOnce();

    store.detach();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledOnce();
  });

  it('keeps background discovery silent in the connection controls', async () => {
    let finishRefresh!: (snapshot: ConnectionSnapshot) => void;
    refresh.mockReturnValue(new Promise((resolve) => {
      finishRefresh = resolve;
    }));
    const store = new ConnectionsStore();
    store.attachListeners();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(refresh).toHaveBeenCalledOnce();
    expect(store.refreshing).toBe(false);
    finishRefresh(SNAPSHOT);
    await Promise.resolve();
  });

  it('preserves the rendered snapshot when only refresh metadata changes', () => {
    const store = new ConnectionsStore();
    store.snapshot = structuredClone(SNAPSHOT);
    store.attachListeners();
    const renderedSnapshot = store.snapshot;
    const publish = onChange.mock.calls[0]?.[0];

    const refreshed = structuredClone(SNAPSHOT);
    refreshed.refreshedAt = '2026-08-13T10:00:30.000Z';
    refreshed.machines[0]!.lastSeenAt = '2026-08-13T10:00:30.000Z';
    publish?.(refreshed);

    expect(store.snapshot).toBe(renderedSnapshot);
  });
});
