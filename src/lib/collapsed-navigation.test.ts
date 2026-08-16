import { describe, expect, it } from 'vitest';

import type { MultiDeviceSessionState } from '@shared/types/multi-device-sessions.js';
import { projectedCollapsedNavigation } from './collapsed-navigation.js';

describe('projectedCollapsedNavigation', () => {
  it('uses the first available remote Session when the remote-only header has no selection yet', () => {
    const state = remoteOnlyState();

    const navigation = projectedCollapsedNavigation(state, null);

    expect(navigation).toMatchObject({
      project: { key: 'project:soloe', name: 'Soloe' },
      workspace: { key: 'workspace:feature', name: 'feature/sidebar' },
      selected: { key: 'device-xps/remote-one' }
    });
    expect(navigation?.sessions.map((session) => session.key)).toEqual([
      'device-xps/remote-one',
      'device-xps/remote-two'
    ]);
  });

  it('keeps project, workspace, and sibling navigation for a selected remote projection', () => {
    const state = remoteOnlyState();

    const navigation = projectedCollapsedNavigation(state, 'device-xps/remote-two');

    expect(navigation).toMatchObject({
      project: { key: 'project:soloe', name: 'Soloe' },
      workspace: { key: 'workspace:feature', name: 'feature/sidebar' },
      selected: { key: 'device-xps/remote-two' }
    });
    expect(navigation?.sessions.map((session) => session.key)).toEqual([
      'device-xps/remote-one',
      'device-xps/remote-two'
    ]);
    expect(navigation?.projects.map(({ project }) => project.key)).toEqual(['project:soloe']);
    expect(navigation?.workspaces.map(({ workspace }) => workspace.key)).toEqual(['workspace:feature']);
  });
});

function remoteOnlyState(): MultiDeviceSessionState {
  return {
      revision: 1,
      capturedAt: '2026-08-16T00:00:00.000Z',
      devices: [{
        deviceId: 'device-mbp',
        name: 'mbp.local',
        state: 'ready',
        available: true,
        local: true,
        platform: 'macos'
      }, {
        deviceId: 'device-xps',
        name: 'xps',
        state: 'ready',
        available: true,
        local: false,
        platform: 'linux'
      }],
      projects: [{
        key: 'project:soloe',
        name: 'Soloe',
        repository: { kind: 'git', canonicalUrl: 'https://github.com/example/soloe.git' },
        workspaces: [{
          key: 'workspace:feature',
          name: 'feature/sidebar',
          branch: 'feature/sidebar',
          locations: [{
            key: 'location:xps',
            deviceId: 'device-xps',
            deviceName: 'xps',
            projectId: 'project-xps',
            path: '/home/dev/soloe-sidebar',
            available: true,
            isMain: false
          }],
          sessions: [remoteProjection('remote-one', 'Terminal 1'), remoteProjection('remote-two', 'Terminal 2')]
        }]
      }],
      unassigned: [],
      archivedSessions: []
    } satisfies MultiDeviceSessionState;
}

function remoteProjection(sessionId: string, name: string) {
  return {
    ref: { deviceId: 'device-xps', sessionId },
    key: `device-xps/${sessionId}`,
    deviceName: 'xps',
    available: true,
    session: {
      id: sessionId,
      name,
      cwd: '/home/dev/soloe-sidebar',
      projectId: 'project-xps',
      runMode: 'linux' as const,
      launch: { type: 'terminal' as const, shell: 'auto' as const },
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
      lastUsedAt: '2026-08-16T00:00:00.000Z'
    },
    runtime: {
      sessionId,
      terminalId: `terminal-${sessionId}`,
      status: 'running' as const
    }
  };
}
