import { describe, expect, it, vi } from 'vitest';

import { terminalControlProof } from '../../../shared/types/terminal.js';
import { TerminalInputLeaseManager } from './TerminalInputLeaseManager.js';

describe('TerminalInputLeaseManager', () => {
  it('creates identity-qualified Session Control with a canonical terminal size', () => {
    const manager = new TerminalInputLeaseManager({
      now: () => Date.parse('2026-08-12T10:00:00.000Z'),
      leaseId: () => 'lease-a'
    });

    const lease = manager.acquire('terminal-1', 'client-a', {
      sessionId: 'session-1',
      ownerDeviceId: 'execution-device',
      controllerDeviceId: 'device-a',
      controllerDeviceName: 'MacBook Pro',
      cols: 132,
      rows: 41
    });

    expect(lease).toMatchObject({
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      ownerDeviceId: 'execution-device',
      controllerDeviceId: 'device-a',
      controllerDeviceName: 'MacBook Pro',
      generation: 1,
      cols: 132,
      rows: 41
    });
  });

  it('renews one controlling Device and rejects another Device', () => {
    let now = Date.parse('2026-08-12T10:00:00.000Z');
    const manager = new TerminalInputLeaseManager({
      now: () => now,
      leaseId: () => 'lease-a',
      ttlMs: 10_000
    });

    const acquired = manager.acquire('terminal-1', 'client-a');
    now += 1_000;
    const renewed = manager.authorizeControl(
      'terminal-1',
      terminalControlProof(acquired),
      'input'
    );

    expect(renewed).toMatchObject({
      leaseId: acquired.leaseId,
      controllerDeviceId: 'client-a',
      expiresAt: '2026-08-12T10:00:11.000Z'
    });
    expect(() => manager.acquire('terminal-1', 'client-b')).toThrowError(
      expect.objectContaining({ code: 'terminal_input_owned' })
    );
    expect(() => manager.authorizeControl('terminal-1', {
      ...terminalControlProof(acquired),
      controllerDeviceId: 'client-b'
    }, 'input')).toThrowError(expect.objectContaining({ code: 'terminal_control_lease_stale' }));
  });

  it('preserves Session Control when the same Device reconnects through a new client transport', () => {
    let leaseSequence = 0;
    const manager = new TerminalInputLeaseManager({
      leaseId: () => `lease-${++leaseSequence}`
    });
    const first = manager.acquire('terminal-1', 'transport-before-reconnect', {
      sessionId: 'session-1',
      ownerDeviceId: 'execution-device',
      controllerDeviceId: 'controller-device',
      controllerDeviceName: 'MacBook Pro'
    });

    const reconnected = manager.acquire('terminal-1', 'transport-after-reconnect', {
      sessionId: 'session-1',
      ownerDeviceId: 'execution-device',
      controllerDeviceId: 'controller-device',
      controllerDeviceName: 'MacBook Pro'
    });

    expect(reconnected).toMatchObject({
      leaseId: first.leaseId,
      generation: first.generation,
      ownerDeviceId: 'execution-device',
      controllerDeviceId: 'controller-device',
      controllerDeviceName: 'MacBook Pro'
    });
    expect(manager.releaseTransportClient('transport-before-reconnect')).toBe(0);
    expect(manager.current('terminal-1')).toMatchObject({ leaseId: first.leaseId });
  });

  it('expires stale ownership and permits a new owner', () => {
    let now = 1_000;
    const events = vi.fn();
    let leaseSequence = 0;
    const manager = new TerminalInputLeaseManager({
      now: () => now,
      leaseId: () => `lease-${++leaseSequence}`,
      ttlMs: 1_000,
      onChange: events
    });

    manager.acquire('terminal-1', 'client-a');
    now = 2_001;
    const acquired = manager.acquire('terminal-1', 'client-b');

    expect(acquired).toMatchObject({ leaseId: 'lease-2', controllerDeviceId: 'client-b' });
    expect(events.mock.calls.map(([event]) => event.type)).toEqual([
      'acquired',
      'expired',
      'acquired'
    ]);
  });

  it('supports explicit visible takeover and rejects the stale lease', () => {
    const events = vi.fn();
    let leaseSequence = 0;
    const manager = new TerminalInputLeaseManager({
      now: () => 2_000,
      leaseId: () => `lease-${++leaseSequence}`,
      onChange: events
    });
    const stale = manager.acquire('terminal-1', 'client-a');

    const current = manager.acquire('terminal-1', 'client-b', { takeover: true });

    expect(current).toMatchObject({ leaseId: 'lease-2', controllerDeviceId: 'client-b' });
    expect(events).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'taken-over',
      previousControllerDeviceId: 'client-a',
      lease: expect.objectContaining({ controllerDeviceId: 'client-b' })
    }));
    expect(() => manager.authorizeControl(
      'terminal-1',
      terminalControlProof(stale),
      'input'
    )).toThrowError(expect.objectContaining({ code: 'terminal_control_lease_stale' }));
  });

  it('rejects stale Session Control proof after takeover', () => {
    let leaseSequence = 0;
    const manager = new TerminalInputLeaseManager({
      leaseId: () => `lease-${++leaseSequence}`
    });
    const stale = manager.acquire('terminal-1', 'client-a', {
      sessionId: 'session-1',
      ownerDeviceId: 'execution-device',
      controllerDeviceId: 'device-a',
      controllerDeviceName: 'MacBook Pro',
      cols: 120,
      rows: 30
    });
    const current = manager.acquire('terminal-1', 'client-b', {
      takeover: true,
      sessionId: 'session-1',
      ownerDeviceId: 'execution-device',
      controllerDeviceId: 'device-b',
      controllerDeviceName: 'iPad',
      cols: stale.cols,
      rows: stale.rows
    });

    expect(current.generation).toBe(stale.generation + 1);
    expect(() => manager.authorizeControl(
      'terminal-1',
      terminalControlProof(stale),
      'input'
    )).toThrowError(expect.objectContaining({ code: 'terminal_control_lease_stale' }));
    expect(() => manager.resize(
      'terminal-1',
      terminalControlProof(stale),
      80,
      24
    )).toThrowError(expect.objectContaining({ code: 'terminal_control_lease_stale' }));

    expect(manager.resize(
      'terminal-1',
      terminalControlProof(current),
      90,
      28
    )).toMatchObject({ generation: current.generation, cols: 90, rows: 28 });
  });

  it('requires every Session Control identity instead of the observation generation', () => {
    const manager = new TerminalInputLeaseManager({ leaseId: () => 'lease-a' });
    const lease = manager.acquire('terminal-1', 'transport-a', {
      sessionId: 'session-1',
      ownerDeviceId: 'execution-device',
      controllerDeviceId: 'controller-device',
      controllerDeviceName: 'MacBook Pro'
    });
    const proof = terminalControlProof(lease);

    for (const stale of [
      { ...proof, sessionId: 'session-2' },
      { ...proof, ownerDeviceId: 'other-execution-device' },
      { ...proof, controllerDeviceId: 'other-controller-device' },
      { ...proof, leaseId: 'other-lease' }
    ]) {
      expect(() => manager.authorizeControl('terminal-1', stale, 'input')).toThrowError(
        expect.objectContaining({ code: 'terminal_control_lease_stale' })
      );
    }

    expect(manager.authorizeControl('terminal-1', proof, 'input')).toMatchObject({
      generation: lease.generation
    });
  });

  it('increments the generation when an unclaimed terminal is claimed again', () => {
    let leaseSequence = 0;
    const manager = new TerminalInputLeaseManager({ leaseId: () => `lease-${++leaseSequence}` });
    const first = manager.acquire('terminal-1', 'client-a');
    manager.release('terminal-1', terminalControlProof(first));

    const second = manager.acquire('terminal-1', 'client-b');

    expect(second.generation).toBe(first.generation + 1);
  });

  it('makes only the newest simultaneous takeover generation authoritative', () => {
    let leaseSequence = 0;
    const manager = new TerminalInputLeaseManager({ leaseId: () => `lease-${++leaseSequence}` });
    manager.acquire('terminal-1', 'client-a');

    const firstTakeover = manager.acquire('terminal-1', 'client-b', { takeover: true });
    const newestTakeover = manager.acquire('terminal-1', 'client-c', { takeover: true });

    expect(newestTakeover.generation).toBe(firstTakeover.generation + 1);
    expect(manager.current('terminal-1')).toMatchObject({
      controllerDeviceId: 'client-c',
      generation: newestTakeover.generation
    });
    expect(() => manager.authorizeControl(
      'terminal-1',
      terminalControlProof(firstTakeover),
      'input'
    )).toThrowError(expect.objectContaining({ code: 'terminal_control_lease_stale' }));
  });

  it('releases only the matching lease and can release every lease for a client', () => {
    let leaseSequence = 0;
    const manager = new TerminalInputLeaseManager({
      leaseId: () => `lease-${++leaseSequence}`
    });
    const first = manager.acquire('terminal-1', 'client-a');
    manager.acquire('terminal-2', 'client-a');
    manager.acquire('terminal-3', 'client-b');

    expect(manager.release('terminal-1', {
      ...terminalControlProof(first),
      leaseId: 'wrong'
    })).toBe(false);
    expect(manager.release('terminal-1', terminalControlProof(first))).toBe(true);
    expect(manager.releaseTransportClient('client-a')).toBe(1);
    expect(manager.current('terminal-2')).toBeNull();
    expect(manager.current('terminal-3')).toMatchObject({ controllerDeviceId: 'client-b' });
  });
});
