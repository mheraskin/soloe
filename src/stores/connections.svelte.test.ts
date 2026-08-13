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
  machines: [],
  tailscale: {
    state: 'connected',
    tailnet: 'example.com',
    selfDnsName: 'client.tail1234.ts.net',
    message: null,
    sharing: { state: 'ready', message: null, setupUrl: null }
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
});
