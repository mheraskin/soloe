import { describe, expect, it, vi } from 'vitest';

import { TerminalInputLeaseManager } from './TerminalInputLeaseManager.js';

describe('TerminalInputLeaseManager', () => {
  it('renews one owner and rejects racing input from another client', () => {
    let now = Date.parse('2026-08-12T10:00:00.000Z');
    const manager = new TerminalInputLeaseManager({
      now: () => now,
      leaseId: () => 'lease-a',
      ttlMs: 10_000
    });

    const acquired = manager.acquire('terminal-1', 'client-a');
    now += 1_000;
    const renewed = manager.authorizeInput('terminal-1', 'client-a', acquired.leaseId);

    expect(renewed).toMatchObject({
      leaseId: acquired.leaseId,
      ownerId: 'client-a',
      expiresAt: '2026-08-12T10:00:11.000Z'
    });
    expect(() => manager.acquire('terminal-1', 'client-b')).toThrowError(
      expect.objectContaining({ code: 'terminal_input_owned' })
    );
    expect(() => manager.authorizeInput('terminal-1', 'client-b', acquired.leaseId)).toThrowError(
      expect.objectContaining({ code: 'terminal_input_owned' })
    );
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

    expect(acquired).toMatchObject({ leaseId: 'lease-2', ownerId: 'client-b' });
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

    expect(current).toMatchObject({ leaseId: 'lease-2', ownerId: 'client-b' });
    expect(events).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'taken-over',
      previousOwnerId: 'client-a',
      lease: expect.objectContaining({ ownerId: 'client-b' })
    }));
    expect(() => manager.authorizeInput('terminal-1', 'client-a', stale.leaseId)).toThrowError(
      expect.objectContaining({ code: 'terminal_input_owned' })
    );
  });

  it('releases only the matching lease and can release every lease for a client', () => {
    let leaseSequence = 0;
    const manager = new TerminalInputLeaseManager({
      leaseId: () => `lease-${++leaseSequence}`
    });
    const first = manager.acquire('terminal-1', 'client-a');
    manager.acquire('terminal-2', 'client-a');
    manager.acquire('terminal-3', 'client-b');

    expect(manager.release('terminal-1', 'client-a', 'wrong')).toBe(false);
    expect(manager.release('terminal-1', 'client-a', first.leaseId)).toBe(true);
    expect(manager.releaseOwner('client-a')).toBe(1);
    expect(manager.current('terminal-2')).toBeNull();
    expect(manager.current('terminal-3')).toMatchObject({ ownerId: 'client-b' });
  });
});
