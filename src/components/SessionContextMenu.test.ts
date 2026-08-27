/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../stores/sessions.svelte', () => ({
  sessions: {
    statusFor: vi.fn(() => 'running'),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    isInActiveSplit: vi.fn(() => false),
    canAddToSplit: vi.fn(() => false),
    addToSplit: vi.fn(),
    removeFromSplit: vi.fn()
  }
}));
vi.mock('../stores/session-context-menus.svelte', () => ({
  sessionContextMenus: { onCloseAll: vi.fn(() => () => undefined) }
}));
vi.mock('../stores/session-handoff.svelte', () => ({ sessionHandoff: { open: vi.fn() } }));
vi.mock('../stores/modal.svelte', () => ({ modal: { openEdit: vi.fn() } }));
vi.mock('../stores/toast.svelte', () => ({ reportError: vi.fn() }));
vi.mock('../lib/ipc', () => ({
  ipc: { system: { openPath: vi.fn() }, sessions: { previewCommand: vi.fn() } }
}));
vi.mock('../lib/session-delete-confirmation', () => ({
  confirmDeleteSession: vi.fn(async () => true)
}));

import Harness from './SessionContextMenu.test-harness.svelte';

describe('SessionContextMenu remote Session actions', () => {
  let mounted: ReturnType<typeof mount> | null = null;

  afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = null;
    await vi.waitFor(() => {
      expect(document.body.style.overflow).toBe('');
    });
    document.body.innerHTML = '';
  });

  it('shows metadata actions and colors alongside remote lifecycle controls', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    mounted = mount(Harness, {
      target,
      props: {
        update: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        previewCommand: vi.fn(async () => ({
          file: 'pnpm',
          args: ['codex'],
          cwd: '/home/dev/soloe',
          env: {},
          description: 'pnpm codex'
        }))
      }
    });
    flushSync();

    target.querySelector('button')?.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20
    }));
    await Promise.resolve();
    flushSync();

    expect(document.body.textContent).toContain('Stop');
    expect(document.body.textContent).toContain('Restart');
    expect(document.body.textContent).toContain('Rename');
    expect(document.body.textContent).toContain('Edit...');
    expect(document.body.textContent).toContain('Copy command');
    expect(document.body.textContent).toContain('Delete');
    expect(document.body.querySelector('[aria-label="Set color Violet"]')).not.toBeNull();
  });
});
