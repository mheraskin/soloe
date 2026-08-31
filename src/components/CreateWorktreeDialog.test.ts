/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitWorktree } from '@shared/types/git.js';

const externalWorktree: GitWorktree = {
  path: '/work/soloe-external',
  branch: 'feature/external',
  head: 'b'.repeat(40),
  detached: false,
  bare: false,
  isMain: false
};

const mocks = vi.hoisted(() => ({
  branches: vi.fn(async () => [
    { name: 'main', current: true, upstream: null, subject: '', committedAt: null },
    { name: 'feature/external', current: false, upstream: null, subject: '', committedAt: null }
  ]),
  createWorktree: vi.fn(),
  loadWorktrees: vi.fn(async (): Promise<GitWorktree[]> => []),
  worktreesErrorFor: vi.fn(() => null),
  openSessionPicker: vi.fn(),
  refreshDevices: vi.fn(async () => undefined),
  reportError: vi.fn(),
  pushToast: vi.fn()
}));

const modalState = vi.hoisted(() => {
  const draft = {
    projectId: 'project-1',
    projectName: 'Soloe',
    repoPath: '/work/soloe',
    baseRef: 'HEAD',
    branch: '',
    path: '/work/soloe-worktree'
  };
  const modal = {
    open: true,
    draft,
    error: null as string | null,
    setBaseRef: vi.fn((value: string) => {
      draft.baseRef = value;
    }),
    setBranch: vi.fn((value: string) => {
      draft.branch = value;
    }),
    setPath: vi.fn((value: string) => {
      draft.path = value;
    }),
    recordCreated: vi.fn(),
    close: vi.fn()
  };
  return { draft, modal };
});
const { draft, modal } = modalState;

vi.mock('../stores/worktree-create-modal.svelte', () => ({
  worktreeCreateModal: modalState.modal
}));

vi.mock('../stores/git.svelte', () => ({
  git: {
    loadWorktrees: mocks.loadWorktrees,
    worktreesErrorFor: mocks.worktreesErrorFor
  }
}));

vi.mock('../stores/new-session-picker.svelte', () => ({
  newSessionPicker: { open: mocks.openSessionPicker }
}));

vi.mock('../stores/device-sessions.svelte', () => ({
  deviceSessions: {
    multiDeviceActive: false,
    refresh: mocks.refreshDevices
  }
}));

vi.mock('../lib/ipc', () => ({
  ipc: {
    git: {
      branches: mocks.branches,
      createWorktree: mocks.createWorktree
    }
  }
}));

vi.mock('../stores/toast.svelte', () => ({
  reportError: mocks.reportError,
  toasts: { push: mocks.pushToast }
}));

import CreateWorktreeDialog from './CreateWorktreeDialog.svelte';

let component: ReturnType<typeof mount> | null = null;

describe('CreateWorktreeDialog', () => {
  beforeEach(() => {
    modal.open = true;
    modal.error = null;
    draft.baseRef = 'HEAD';
    draft.branch = '';
    draft.path = '/work/soloe-worktree';
    vi.clearAllMocks();
    mocks.loadWorktrees.mockResolvedValue([externalWorktree]);
    component = mount(CreateWorktreeDialog, { target: document.body });
  });

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.replaceChildren();
  });

  it('rescans and opens an externally created Worktree', async () => {
    await vi.waitFor(() => expect(mocks.loadWorktrees).toHaveBeenCalledWith(
      draft.repoPath,
      true,
      {}
    ));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('feature/external');
      expect(document.body.textContent).toContain('/work/soloe-external');
    });

    const open = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Open session'));
    expect(open).toBeDefined();
    open?.click();
    flushSync();

    expect(mocks.openSessionPicker).toHaveBeenCalledWith({
      projectId: draft.projectId,
      cwd: externalWorktree.path,
      branch: externalWorktree.branch
    });
    expect(modal.close).toHaveBeenCalled();
  });

  it('keeps the source revision editable while loading branch suggestions', () => {
    const input = document.querySelector<HTMLInputElement>('#worktree-base');
    expect(input).not.toBeNull();
    if (!input) return;

    input.value = 'release/next';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));

    expect(modal.setBaseRef).toHaveBeenCalledWith('release/next');
  });
});
