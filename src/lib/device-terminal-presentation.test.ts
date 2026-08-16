import { describe, expect, it } from 'vitest';
import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
import appSource from '../App.svelte?raw';
import { deviceTerminalPresentationKey } from './device-terminal-presentation';

describe('device terminal presentation identity', () => {
  it('reconstructs a remote presentation when its runtime terminal changes', () => {
    const first = projection('terminal-1', 'Original name');
    const restarted = projection('terminal-2', 'Original name');
    const renamed = projection('terminal-1', 'Renamed session');

    expect(deviceTerminalPresentationKey(restarted)).not.toBe(
      deviceTerminalPresentationKey(first)
    );
    expect(deviceTerminalPresentationKey(renamed)).toBe(
      deviceTerminalPresentationKey(first)
    );
  });

  it('keys both remote terminal surfaces by presentation identity', () => {
    expect(appSource.match(/#key deviceTerminalPresentationKey\(deviceSessions\.selectedProjection\)/gu))
      .toHaveLength(2);
    expect(appSource).not.toContain('#key deviceSessions.selectedProjection.key');
  });
});

function projection(
  terminalId: string,
  name: string
): MultiDeviceSessionView {
  return {
    ref: { deviceId: 'device-xps', sessionId: 'session-1' },
    key: 'device-xps/session-1',
    deviceName: 'xps',
    available: true,
    session: {
      id: 'session-1',
      name,
      cwd: '/home/me/project',
      runMode: 'linux',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
      createdAt: '2026-08-16T00:00:00.000Z',
      lastUsedAt: '2026-08-16T00:00:00.000Z'
    },
    runtime: {
      sessionId: 'session-1',
      terminalId,
      status: 'running'
    }
  };
}
