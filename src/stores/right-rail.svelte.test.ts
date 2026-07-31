/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { RightRailStore } from './right-rail.svelte';

describe('RightRailStore logical continuity', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('restores each Worktree layout without requiring its Rail Surfaces to stay mounted', () => {
    const store = new RightRailStore();
    store.setActiveCwd('/worktrees/alpha');
    store.openTab('diff');
    store.openTab('files');
    store.setDiffScrollTop('/worktrees/alpha', 420);
    store.setFilesTreeScrollTop('/worktrees/alpha', 180);

    store.setActiveCwd('/worktrees/beta');
    expect(store.openTabs).toEqual([]);
    store.openTab('feature');
    expect(store.openTabs).toEqual(['feature']);

    store.setActiveCwd('/worktrees/alpha');
    expect(store.openTabs).toEqual(['diff', 'files']);
    expect(store.getDiffScrollTop('/worktrees/alpha')).toBe(420);
    expect(store.getFilesTreeScrollTop('/worktrees/alpha')).toBe(180);
  });

  it('reconstructs persisted layout after the renderer-owned store is recreated', () => {
    const first = new RightRailStore();
    first.setActiveCwd('/worktrees/alpha');
    first.openTab('diff');
    first.openTab('files');

    const restored = new RightRailStore();
    restored.setActiveCwd('/worktrees/alpha');

    expect(restored.openTabs).toEqual(['diff', 'files']);
  });

  it('exposes and mounts only the most recent pane in the mobile layout', () => {
    const store = new RightRailStore();
    store.setActiveCwd('/worktrees/alpha');
    store.openTab('diff');
    store.openTab('files');

    store.setPaneLimit(1);
    expect(store.openTabs).toEqual(['files']);

    store.openTab('notes');
    expect(store.openTabs).toEqual(['notes']);
  });

  it('does not invent a pane when fullscreen is requested with no pane open', () => {
    const store = new RightRailStore();
    store.setActiveCwd('/worktrees/alpha');

    store.toggleFullscreen();

    expect(store.openTabs).toEqual([]);
    expect(store.fullscreen).toBe(false);
    expect(store.fullscreenTab).toBeNull();
  });
});
