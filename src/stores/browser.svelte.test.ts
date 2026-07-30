/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserStore } from './browser.svelte';
import { worktreeScope, worktreeScopeKey } from '@shared/worktree-identity.js';

describe('BrowserStore residency', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function add(store: BrowserStore, url: string) {
    vi.advanceTimersByTime(1_000);
    return store.addTab(url);
  }

  it('keeps the active tab plus the most-recent background tabs resident', () => {
    const store = new BrowserStore();
    const tabs = [1, 2, 3, 4, 5].map((n) => add(store, `https://tab-${n}.test`));

    expect(store.residentTabs(3).map((tab) => tab.id)).toEqual([
      tabs[2]!.id,
      tabs[3]!.id,
      tabs[4]!.id
    ]);

    vi.advanceTimersByTime(1_000);
    store.selectTab(tabs[0]!.id);
    expect(store.residentTabs(3).map((tab) => tab.id)).toEqual([
      tabs[0]!.id,
      tabs[3]!.id,
      tabs[4]!.id
    ]);
  });

  it('never exceeds the residency cap while rapidly selecting many tabs', () => {
    const store = new BrowserStore();
    const tabs = Array.from({ length: 50 }, (_, index) =>
      add(store, `https://tab-${index}.test`)
    );
    expect(store.residentTabs(2)).toHaveLength(2);

    for (const tab of [...tabs].reverse()) {
      store.selectTab(tab.id);
      const residents = store.residentTabs(2);
      expect(residents.length).toBeLessThanOrEqual(2);
      expect(residents.some((resident) => resident.id === tab.id)).toBe(true);
    }
  });

  it('owns active-tab and manual-pause invariants inside the store', () => {
    const store = new BrowserStore();
    const first = add(store, 'https://first.test');
    const second = add(store, 'https://second.test');

    store.pauseTab(second.id);
    expect(store.isPaused(second.id)).toBe(false);

    store.selectTab(first.id);
    store.pauseTab(second.id);
    expect(store.isPaused(second.id)).toBe(true);
    expect(store.residentTabs(5).map((tab) => tab.id)).toEqual([first.id]);

    store.selectTab(second.id);
    expect(store.activeTabId).toBe(second.id);
    expect(store.isPaused(second.id)).toBe(false);
    expect(store.residentTabs(1).map((tab) => tab.id)).toEqual([second.id]);
  });

  it('does not allocate a renderer when a manual pause expires in the background', () => {
    const store = new BrowserStore();
    const first = add(store, 'https://first.test');
    const second = add(store, 'https://second.test');
    store.selectTab(first.id);
    store.pauseTab(second.id);

    store.resumeTab(second.id, false);
    expect(store.isPaused(second.id)).toBe(false);
    expect(store.residentTabs(5).map((tab) => tab.id)).toEqual([first.id]);

    store.selectTab(second.id);
    expect(store.residentTabs(2).map((tab) => tab.id)).toEqual([first.id, second.id]);
  });

  it('releases all background residents when the Browser rail hides', () => {
    const store = new BrowserStore();
    add(store, 'https://first.test');
    const second = add(store, 'https://second.test');
    expect(store.residentTabs(2)).toHaveLength(2);

    store.releaseResidents();
    expect(store.residentTabs(2).map((tab) => tab.id)).toEqual([second.id]);
  });

  it('keeps residency independent per worktree', () => {
    const store = new BrowserStore();
    store.setActiveScope(worktreeScope('/repo-a', { runMode: 'wsl', wslDistro: 'Ubuntu' }));
    const a1 = add(store, 'https://a1.test');
    const a2 = add(store, 'https://a2.test');
    store.setActiveScope(worktreeScope('/repo-b', { runMode: 'wsl', wslDistro: 'Ubuntu' }));
    const b1 = add(store, 'https://b1.test');

    expect(store.residentTabs(1).map((tab) => tab.id)).toEqual([b1.id]);
    store.setActiveScope(worktreeScope('/repo-a', { runMode: 'wsl', wslDistro: 'Ubuntu' }));
    expect(store.residentTabs(1).map((tab) => tab.id)).toEqual([a2.id]);
    expect(store.tabs.map((tab) => tab.id)).toEqual([a1.id, a2.id]);
  });

  it('isolates equal paths in different WSL distributions', () => {
    const store = new BrowserStore();
    const ubuntu = worktreeScope('/same-path', { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const debian = worktreeScope('/same-path', { runMode: 'wsl', wslDistro: 'Debian' });
    store.setActiveScope(ubuntu);
    const ubuntuTab = add(store, 'https://ubuntu.test');

    store.setActiveScope(debian);
    expect(store.tabs).toEqual([]);
    const debianTab = add(store, 'https://debian.test');

    store.setActiveScope(ubuntu);
    expect(store.tabs.map((tab) => tab.id)).toEqual([ubuntuTab.id]);
    expect(store.tabs.some((tab) => tab.id === debianTab.id)).toBe(false);
  });

  it('seeds path-only browser history independently into each exact runtime', () => {
    localStorage.setItem('soloe.browser.v1', JSON.stringify({
      '/legacy': {
        tabs: [{
          id: 'legacy', title: 'Legacy', history: ['https://legacy.test'], historyIndex: 0
        }],
        activeTabId: 'legacy'
      }
    }));
    const store = new BrowserStore();
    store.setActiveScope(worktreeScope('/legacy', { runMode: 'wsl', wslDistro: 'Ubuntu' }));

    expect(store.tabs.map((tab) => tab.id)).toEqual(['legacy']);
    store.navigate('legacy', 'https://ubuntu.test');
    store.setActiveScope(worktreeScope('/legacy', { runMode: 'wsl', wslDistro: 'Debian' }));
    expect(store.activeUrl()).toBe('https://legacy.test');
    store.setActiveScope(worktreeScope('/legacy', { runMode: 'wsl', wslDistro: 'Ubuntu' }));
    expect(store.activeUrl()).toBe('https://ubuntu.test');
  });

  it('repairs a persisted active tab that was incorrectly paused', () => {
    localStorage.setItem('soloe.browser.v2', JSON.stringify({
      __none__: {
        tabs: [{
          id: 'active',
          title: 'Active',
          history: ['https://active.test'],
          historyIndex: 0,
          pausedAt: 123
        }],
        activeTabId: 'active'
      }
    }));

    const store = new BrowserStore();
    expect(store.isPaused('active')).toBe(false);
    expect(store.residentTabs(1)).toHaveLength(1);
  });

  it('batches frequent tab mutations into one exact-scope persistence write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const store = new BrowserStore();
    setItem.mockClear();
    const tab = store.addTab('https://initial.test');
    store.navigate(tab.id, 'https://next.test');
    store.setTitle(tab.id, 'Next page');

    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    const scopeWrites = setItem.mock.calls.filter(([key]) =>
      String(key).startsWith('soloe.browser.v3.scope:')
    );
    expect(scopeWrites).toHaveLength(1);
    expect(setItem).toHaveBeenCalledWith(
      'soloe.browser.v3.index',
      JSON.stringify(['__none__'])
    );
    const persisted = JSON.parse(String(scopeWrites[0]?.[1]));
    expect(persisted.tabs[0]).toMatchObject({
      title: 'Next page',
      history: ['https://initial.test', 'https://next.test']
    });
  });

  it('keeps page and responsive canvas zoom independent for every tab', () => {
    const store = new BrowserStore();
    const first = add(store, 'https://same-origin.test/first');
    const second = add(store, 'https://same-origin.test/second');

    store.setPageZoom(first.id, 1.25);
    store.setCanvasZoom(first.id, 0.67);
    store.setPageZoom(second.id, 0.9);
    store.setCanvasZoom(second.id, 1.5);

    store.selectTab(first.id);
    expect(store.activeTab).toMatchObject({ pageZoom: 1.25, canvasZoom: 0.67 });
    store.selectTab(second.id);
    expect(store.activeTab).toMatchObject({ pageZoom: 0.9, canvasZoom: 1.5 });

    vi.advanceTimersByTime(100);
    const restored = new BrowserStore();
    restored.selectTab(first.id);
    expect(restored.activeTab).toMatchObject({ pageZoom: 1.25, canvasZoom: 0.67 });
    restored.selectTab(second.id);
    expect(restored.activeTab).toMatchObject({ pageZoom: 0.9, canvasZoom: 1.5 });
  });

  it('rewrites only the changed scope instead of serializing all browser state', () => {
    const store = new BrowserStore();
    const first = worktreeScope('/repo-a', { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const second = worktreeScope('/repo-b', { runMode: 'wsl', wslDistro: 'Ubuntu' });
    store.setActiveScope(first);
    store.addTab('https://a.test');
    vi.advanceTimersByTime(100);

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    setItem.mockClear();
    store.setActiveScope(second);
    store.addTab('https://b.test');
    vi.advanceTimersByTime(100);

    const scopeWrites = setItem.mock.calls
      .map(([key]) => String(key))
      .filter((key) => key.startsWith('soloe.browser.v3.scope:'));
    expect(scopeWrites).toHaveLength(1);
    expect(scopeWrites[0]).toContain(worktreeScopeKey(second));
    expect(scopeWrites[0]).not.toContain(worktreeScopeKey(first));
  });

  it('bounds historical scopes and per-scope tab payloads', () => {
    const store = new BrowserStore();
    const scopes = Array.from({ length: 70 }, (_, index) =>
      worktreeScope(`/repo-${index}`, { runMode: 'wsl', wslDistro: 'Ubuntu' })
    );
    for (const scope of scopes) {
      store.setActiveScope(scope);
      store.addTab(`https://${scope.cwd.slice(1)}.test`);
    }
    store.setActiveScope(scopes[69]);
    for (let tab = 0; tab < 29; tab += 1) {
      store.addTab(`https://large-${tab}.test/${'x'.repeat(9_000)}`);
    }
    vi.advanceTimersByTime(100);

    const index = JSON.parse(localStorage.getItem('soloe.browser.v3.index') ?? '[]');
    expect(index).toHaveLength(64);
    expect(index[0]).toBe(worktreeScopeKey(scopes[6]!));
    const persisted = JSON.parse(
      localStorage.getItem(`soloe.browser.v3.scope:${worktreeScopeKey(scopes[69]!)}`) ?? '{}'
    );
    expect(persisted.tabs).toHaveLength(24);
    expect(persisted.tabs.at(-1).history[0].length).toBe(8_192);

    store.setActiveScope(scopes[0]);
    expect(store.tabs).toEqual([]);
  });

  it('evicts oldest scopes before exceeding the global storage budget', () => {
    const store = new BrowserStore();
    for (let scopeIndex = 0; scopeIndex < 30; scopeIndex += 1) {
      store.setActiveScope(worktreeScope(`/large-${scopeIndex}`, {
        runMode: 'wsl',
        wslDistro: 'Ubuntu'
      }));
      for (let tab = 0; tab < 24; tab += 1) {
        store.addTab(`https://scope-${scopeIndex}-${tab}.test/${'x'.repeat(9_000)}`);
      }
    }
    vi.advanceTimersByTime(100);

    const index = JSON.parse(localStorage.getItem('soloe.browser.v3.index') ?? '[]') as string[];
    const totalChars = index.reduce(
      (total, key) => total + (localStorage.getItem(`soloe.browser.v3.scope:${key}`)?.length ?? 0),
      0
    );
    expect(index.length).toBeLessThan(30);
    expect(index.at(-1)).toContain('/large-29');
    expect(totalChars).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it('migrates whole-world v2 state into bounded per-scope entries', () => {
    localStorage.setItem('soloe.browser.v2', JSON.stringify({
      __none__: {
        tabs: [{
          id: 'legacy-v2',
          title: 'Legacy v2',
          history: ['https://legacy-v2.test'],
          historyIndex: 0
        }],
        activeTabId: 'legacy-v2'
      }
    }));

    const store = new BrowserStore();
    expect(store.activeTabId).toBe('legacy-v2');
    vi.advanceTimersByTime(100);

    expect(localStorage.getItem('soloe.browser.v2')).toBeNull();
    expect(localStorage.getItem('soloe.browser.v3.index')).toBe(JSON.stringify(['__none__']));
    expect(localStorage.getItem('soloe.browser.v3.scope:__none__')).toContain('legacy-v2');
  });
});
