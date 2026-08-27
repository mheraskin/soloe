/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionSnapshot } from '@shared/types/connections.js';

const { refresh, setupShortDns, removeShortDns, onChange, off } = vi.hoisted(() => ({
  refresh: vi.fn(),
  setupShortDns: vi.fn(),
  removeShortDns: vi.fn(),
  onChange: vi.fn(),
  off: vi.fn()
}));

vi.mock('../lib/ipc', () => ({
  supportsBackendOperation: () => true,
  ipc: {
    connections: {
      get: vi.fn(),
      refresh,
      setupShortDns,
      removeShortDns,
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

  it('updates the snapshot after removing the local DNS helper', async () => {
    const removed = structuredClone(SNAPSHOT);
    removed.shortDns = {
      state: 'setup-required',
      zone: 'client',
      nameserver: '100.64.0.1',
      message: 'Install Soloe DNS on this Device.',
      setupUrl: null,
      readyZones: []
    };
    removeShortDns.mockResolvedValue(removed);
    const store = new ConnectionsStore();

    await store.removeShortDns();

    expect(removeShortDns).toHaveBeenCalledOnce();
    expect(store.snapshot.shortDns.state).toBe('setup-required');
  });

  it('targets the selected remote Device when installing short DNS', async () => {
    const installed = structuredClone(SNAPSHOT);
    installed.machines.push({
      id: 'device:22222222-2222-4222-8222-222222222222',
      deviceId: '22222222-2222-4222-8222-222222222222',
      name: 'xps',
      endpoint: 'https://xps.example.test',
      endpointAliases: [],
      source: 'discovered',
      status: 'available',
      trust: 'pinned',
      enabled: true,
      active: false,
      isSelf: false,
      lastSeenAt: '2026-08-27T10:00:00.000Z',
      shortDns: {
        state: 'ready',
        zone: 'xps',
        nameserver: '100.64.0.2',
        message: null,
        setupUrl: null,
        readyZones: ['xps']
      }
    });
    setupShortDns.mockResolvedValue(installed);
    const store = new ConnectionsStore();

    await store.setupShortDns('device:22222222-2222-4222-8222-222222222222');

    expect(setupShortDns).toHaveBeenCalledWith(
      'device:22222222-2222-4222-8222-222222222222'
    );
    expect(store.snapshot.machines[1]?.shortDns?.state).toBe('ready');
  });
});
