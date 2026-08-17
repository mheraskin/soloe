import { describe, expect, it, vi } from 'vitest';

import type {
  TerminalControllerIdentity,
  TerminalInputLease,
  TerminalInputLeaseEvent
} from '@shared/types/terminal.js';
import {
  resolveTerminalControllerIdentity,
  TerminalControlCoordinator,
  type TerminalControlBackend
} from './terminal-control.js';

function lease(terminalId: string, ownerId: string, generation: number): TerminalInputLease {
  return {
    terminalId,
    sessionId: `session-${terminalId}`,
    ownerDeviceId: 'execution-device',
    leaseId: `lease-${generation}`,
    controllerDeviceId: `device-${ownerId}`,
    controllerDeviceName: ownerId,
    generation,
    cols: 120,
    rows: 30,
    acquiredAt: '2026-08-15T08:00:00.000Z',
    expiresAt: '2026-08-15T08:00:15.000Z'
  };
}

function backend(): TerminalControlBackend & {
  events: (event: TerminalInputLeaseEvent) => void;
  released: string[];
  acquired: Array<{
    terminalId: string;
    identity: TerminalControllerIdentity;
    takeover: boolean;
  }>;
} {
  let listener: (event: TerminalInputLeaseEvent) => void = () => undefined;
  let generation = 0;
  let current: TerminalInputLease | null = null;
  const released: string[] = [];
  const acquired: Array<{
    terminalId: string;
    identity: TerminalControllerIdentity;
    takeover: boolean;
  }> = [];
  return {
    acquire: async (terminalId, identity, takeover) => {
      acquired.push({ terminalId, identity: structuredClone(identity), takeover });
      if (current && !takeover) throw new Error('owned');
      current = lease(terminalId, identity.deviceName, ++generation);
      listener({
        type: generation === 1 ? 'acquired' : 'taken-over',
        terminalId,
        lease: current,
        observedAt: new Date().toISOString()
      });
      return current;
    },
    current: async () => current,
    release: async (terminalId) => {
      released.push(terminalId);
      current = null;
      listener({
        type: 'released',
        terminalId,
        lease: null,
        observedAt: new Date().toISOString()
      });
      return true;
    },
    input: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    onLease: (next) => {
      listener = next;
      return () => undefined;
    },
    events: (event) => listener(event),
    released,
    acquired
  };
}

const identity: TerminalControllerIdentity = {
  deviceId: 'device-local',
  deviceName: 'MacBook Pro'
};

describe('TerminalControlCoordinator', () => {
  it('uses the viewing Soloe Device as the durable controller identity', () => {
    expect(resolveTerminalControllerIdentity(
      { deviceId: 'device-mbp', name: 'mbp.local' },
      { deviceId: 'browser-tab-id', deviceName: 'MacIntel' }
    )).toEqual({ deviceId: 'device-mbp', deviceName: 'mbp.local' });
  });

  it('resolves the durable Device identity when control is first claimed', async () => {
    const control = backend();
    let currentIdentity = { deviceId: 'browser-tab-id', deviceName: 'MacIntel' };
    const coordinator = new TerminalControlCoordinator(control, () => currentIdentity);
    currentIdentity = { deviceId: 'device-mbp', deviceName: 'mbp.local' };

    await coordinator.select('terminal-a');

    expect(control.acquired).toEqual([
      { terminalId: 'terminal-a', takeover: false, identity: currentIdentity }
    ]);
  });

  it('claims an unclaimed selected terminal and releases it when switching away', async () => {
    const control = backend();
    const coordinator = new TerminalControlCoordinator(control, identity);

    await coordinator.select('terminal-a');
    expect(coordinator.owns('terminal-a')).toBe(true);

    await coordinator.select('terminal-b');
    expect(control.released).toEqual(['terminal-a']);
    expect(coordinator.owns('terminal-b')).toBe(true);
  });

  it('parks control affinity while dropping exclusivity on deselect', async () => {
    const control = backend();
    const parked: string[] = [];
    control.park = async (terminalId) => {
      parked.push(terminalId);
      control.events({
        type: 'released',
        terminalId,
        lease: null,
        observedAt: new Date().toISOString()
      });
      return true;
    };
    const coordinator = new TerminalControlCoordinator(control, identity);

    await coordinator.select('terminal-a');
    await coordinator.select(null);

    expect(parked).toEqual(['terminal-a']);
    expect(control.released).toEqual([]);
    expect(coordinator.owns('terminal-a')).toBe(false);
  });

  it('stops controlling immediately when a newer takeover event arrives', async () => {
    const control = backend();
    const coordinator = new TerminalControlCoordinator(control, identity);
    await coordinator.select('terminal-a');

    control.events({
      type: 'taken-over',
      terminalId: 'terminal-a',
      lease: lease('terminal-a', 'iPad', 2),
      previousControllerDeviceId: 'device-MacBook Pro',
      observedAt: '2026-08-15T08:01:00.000Z'
    });

    expect(coordinator.owns('terminal-a')).toBe(false);
    await expect(coordinator.input('terminal-a', 'stale')).rejects.toThrow(/lease/u);
  });

  it('releases control when the Session view becomes hidden', async () => {
    const control = backend();
    const coordinator = new TerminalControlCoordinator(control, identity);
    await coordinator.select('terminal-a');

    await coordinator.setPageVisible(false);

    expect(control.released).toEqual(['terminal-a']);
    expect(coordinator.owns('terminal-a')).toBe(false);
  });

  it('recognizes renewed control held by this durable Soloe Device', () => {
    const control = backend();
    const coordinator = new TerminalControlCoordinator(control, identity);
    const acquired = {
      ...lease('terminal-a', 'mbp.local', 1),
      controllerDeviceId: identity.deviceId,
      controllerDeviceName: 'mbp.local'
    };

    control.events({
      type: 'acquired',
      terminalId: 'terminal-a',
      lease: acquired,
      observedAt: '2026-08-15T08:01:00.000Z'
    });
    expect(coordinator.owns('terminal-a')).toBe(true);

    control.events({
      type: 'renewed',
      terminalId: 'terminal-a',
      lease: { ...acquired, leaseId: 'lease-2', generation: 2 },
      observedAt: '2026-08-15T08:01:05.000Z'
    });
    expect(coordinator.owns('terminal-a')).toBe(true);
  });
});
