import { describe, expect, it } from 'vitest';
import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
import appSource from '../App.svelte?raw';
import {
  deviceSessionStatus,
  deviceSessionSurface,
  deviceTerminalPresentationKey
} from './device-terminal-presentation';

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

  it('mounts one global terminal residency stage in each responsive branch', () => {
    expect(appSource.match(/<TerminalStage/gu)).toHaveLength(2);
    expect(appSource).not.toContain('#key deviceTerminalPresentationKey(deviceSessions.selectedProjection)');
    expect(appSource).not.toContain('#key deviceSessions.selectedProjection.key');
    expect(appSource).not.toContain('<DeviceTerminalStage');
    expect(appSource).not.toContain('<DeviceSessionArea');
    expect(appSource).not.toContain('<DeviceTerminalViewer');
  });

  it('uses the resumable empty surface when a remote Session has exited', () => {
    const exited = projection('terminal-1', 'Original name');
    exited.runtime = { ...exited.runtime!, terminalId: null, status: 'exited' };

    expect(deviceSessionSurface(exited)).toBe('empty');
    expect(deviceSessionSurface(projection('terminal-1', 'Original name'))).toBe('terminal');
  });

  it('renders lifecycle pending intent without replacing Device-authoritative runtime state', () => {
    const running = projection('terminal-1', 'Original name');

    expect(deviceSessionSurface(running, true)).toBe('empty');
    expect(running.runtime?.status).toBe('running');
  });

  it('defaults a projection without Device lifecycle facts to stopped', () => {
    const unknown = projection('terminal-1', 'Original name');
    unknown.runtime = null;
    delete unknown.lifecycleStatus;

    expect(deviceSessionStatus(unknown)).toBe('stopped');
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
    },
    observation: null
  };
}
