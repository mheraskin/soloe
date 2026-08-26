/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../stores/sessions.svelte', () => ({
  sessions: {
    selected: null,
    runtime: {},
    statusFor: vi.fn(() => 'stopped'),
    observationFor: vi.fn(() => null),
    currentCwdFor: vi.fn(() => null)
  }
}));

vi.mock('../stores/modal.svelte', () => ({ modal: { openEdit: vi.fn() } }));
vi.mock('../stores/toast.svelte', () => ({ reportError: vi.fn(), toasts: { push: vi.fn() } }));
vi.mock('../lib/ipc', () => ({
  ipc: {
    system: { openPath: vi.fn() },
    files: { openInEditor: vi.fn() },
    sessions: { previewCommand: vi.fn() }
  }
}));

import SessionToolbar from './SessionToolbar.svelte';

describe('SessionToolbar', () => {
  let mounted: ReturnType<typeof mount> | null = null;

  afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = null;
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.body.innerHTML = '';
  });

  it('keeps remote metadata scrollable while actions stay fixed', async () => {
    const onClose = vi.fn();
    const target = document.createElement('div');
    document.body.append(target);
    mounted = mount(SessionToolbar, {
      target,
      props: {
        projection: {
          ref: { deviceId: 'device-xps', sessionId: 'remote-session' },
          key: 'device-xps/remote-session',
          deviceName: 'xps',
          available: true,
          session: {
            id: 'remote-session',
            name: 'Remote terminal',
            cwd: '/home/dev/soloe',
            runMode: 'linux',
            launch: { type: 'terminal', shell: 'auto' },
            createdAt: '2026-08-16T00:00:00.000Z',
            lastUsedAt: '2026-08-16T00:00:00.000Z'
          },
          runtime: {
            sessionId: 'remote-session',
            terminalId: 'terminal-remote',
            status: 'running'
          }
        },
        onClose
      }
    });
    flushSync();

    expect(target.querySelector('.session-toolbar')).not.toBeNull();
    expect(target.textContent).toContain('Remote terminal');
    expect(target.textContent).toContain('xps');
    const scroll = target.querySelector('.session-toolbar-scroll');
    const actions = target.querySelector('.session-toolbar-actions');
    expect(scroll).not.toBeNull();
    expect(scroll?.querySelector('.session-toolbar-branch')).toBeNull();
    expect(actions?.querySelector('.session-toolbar-branch')).not.toBeNull();
    expect(actions?.querySelector('[aria-label="More actions"]')).not.toBeNull();
    expect(actions?.querySelector('[aria-label="Close remote terminal"]')).toBeNull();

    actions?.querySelector<HTMLButtonElement>('[aria-label="More actions"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Close remote terminal'));
    const close = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes('Close remote terminal'));
    expect(close).not.toBeNull();
    close?.click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
