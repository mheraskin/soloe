import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

import DeviceSessionArea from './DeviceSessionArea.svelte';

describe('DeviceSessionArea', () => {
  it('renders the resumable exited state instead of an attachment error', () => {
    const { body } = render(DeviceSessionArea, {
      props: {
        projection: {
          ref: { deviceId: 'device-xps', sessionId: 'session-1' },
          key: 'device-xps/session-1',
          deviceName: 'xps',
          available: true,
          session: {
            id: 'session-1',
            name: 'Remote Codex',
            cwd: '/home/me/project',
            runMode: 'linux',
            launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
            createdAt: '2026-08-16T00:00:00.000Z',
            lastUsedAt: '2026-08-16T00:00:00.000Z'
          },
          lifecycleStatus: 'exited',
          runtime: null,
          observation: null
        },
        onClose: () => undefined
      }
    });

    expect(body).toContain('Session exited.');
    expect(body).toContain('Resume');
    expect(body).toContain('New session');
    expect(body).toContain('Continue in another agent');
    expect(body).toContain('Claude');
    expect(body).toContain('Codex');
    expect(body).toContain('Cursor');
    expect(body).not.toContain('no running terminal to attach');
  });

  it('keeps the selected Session context rendered while resume is starting', () => {
    const { body } = render(DeviceSessionArea, {
      props: {
        projection: {
          ref: { deviceId: 'device-xps', sessionId: 'session-1' },
          key: 'device-xps/session-1',
          deviceName: 'xps',
          available: true,
          session: {
            id: 'session-1',
            name: 'Remote Codex',
            cwd: '/home/me/project',
            runMode: 'linux',
            launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
            createdAt: '2026-08-16T00:00:00.000Z',
            lastUsedAt: '2026-08-16T00:00:00.000Z'
          },
          lifecycleStatus: 'starting',
          runtime: null,
          observation: null
        },
        onClose: () => undefined
      }
    });

    expect(body).toContain('Remote Codex');
    expect(body).toContain('/home/me/project');
    expect(body).toContain('Starting session…');
    expect(body).not.toContain('skeleton');
  });
});
