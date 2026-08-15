import { describe, expect, it, vi } from 'vitest';

import type {
  TerminalControllerIdentity,
  TerminalInputLease,
  TerminalInputLeaseEvent
} from '@shared/types/terminal.js';
import { TerminalControlCoordinator, type TerminalControlBackend } from './terminal-control.js';

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
} {
  let listener: (event: TerminalInputLeaseEvent) => void = () => undefined;
  let generation = 0;
  let current: TerminalInputLease | null = null;
  const released: string[] = [];
  return {
    acquire: async (terminalId, identity, takeover) => {
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
    released
  };
}

const identity: TerminalControllerIdentity = {
  deviceId: 'device-local',
  deviceName: 'MacBook Pro'
};

describe('TerminalControlCoordinator', () => {
  it('claims an unclaimed selected terminal and releases it when switching away', async () => {
    const control = backend();
    const coordinator = new TerminalControlCoordinator(control, identity);

    await coordinator.select('terminal-a');
    expect(coordinator.owns('terminal-a')).toBe(true);

    await coordinator.select('terminal-b');
    expect(control.released).toEqual(['terminal-a']);
    expect(coordinator.owns('terminal-b')).toBe(true);
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
});
