import {
  worktreeScope,
  worktreeScopeKey,
  type WorktreeScope
} from '@shared/worktree-identity.js';
import type {
  BrowserSessionScopeState,
  BrowserSessionSnapshot,
  BrowserSessionTab,
  BrowserSessionUpdateRequest,
  BrowserTabDevice as SharedBrowserTabDevice,
  BrowserTargetDevice as SharedBrowserTargetDevice
} from '@shared/types/browser-sessions.js';
import { ipc } from '../lib/ipc';
import { normalizeBrowserUrl } from '../lib/browser-navigation';

export type BrowserTabDevice = SharedBrowserTabDevice;
export type BrowserTargetDevice = SharedBrowserTargetDevice;
export type BrowserTab = BrowserSessionTab;
type BrowserCwdState = BrowserSessionScopeState;

export interface BrowserSessionPersistence {
  load(): Promise<BrowserSessionSnapshot>;
  update(request: BrowserSessionUpdateRequest): Promise<unknown>;
}

interface ClosedBrowserTab {
  tab: BrowserTab;
  index: number;
}

const NO_WORKTREE_KEY = '__none__';
const STORAGE_INDEX_KEY = 'soloe.browser.v3.index';
const STORAGE_SCOPE_PREFIX = 'soloe.browser.v3.scope:';
const WHOLE_STATE_STORAGE_KEY = 'soloe.browser.v2';
const LEGACY_STORAGE_KEY = 'soloe.browser.v1';
const DEFAULT_URL = 'about:blank';
const MAX_HISTORY = 100;
const MAX_PERSISTED_SCOPES = 64;
const MAX_PERSISTED_TABS = 24;
const MAX_CLOSED_TABS = 25;
const MAX_URL_CHARS = 8_192;
const MAX_TITLE_CHARS = 512;
const MAX_SCOPE_STORAGE_CHARS = 256 * 1024;
const MAX_TOTAL_STORAGE_CHARS = 4 * 1024 * 1024;
const PERSIST_DELAY_MS = 100;

const EMPTY_STATE: BrowserCwdState = { tabs: [], activeTabId: null };

function isDevice(value: unknown): value is BrowserTabDevice {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.presetId === 'string'
    && typeof d.width === 'number' && Number.isFinite(d.width) && d.width > 0
    && typeof d.height === 'number' && Number.isFinite(d.height) && d.height > 0
    && typeof d.dpr === 'number' && Number.isFinite(d.dpr) && d.dpr > 0
    && typeof d.mobile === 'boolean'
    && typeof d.ua === 'string'
    && typeof d.rotated === 'boolean'
  );
}

function isZoomFactor(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 5;
}

function isTargetDevice(value: unknown): value is BrowserTargetDevice {
  if (!value || typeof value !== 'object') return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target.deviceId === 'string'
    && typeof target.name === 'string'
    && (target.tailscaleDnsName === null || typeof target.tailscaleDnsName === 'string')
    && typeof target.local === 'boolean'
  );
}

function isTab(value: unknown): value is BrowserTab {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  if (typeof t.id !== 'string' || typeof t.title !== 'string') return false;
  if (!Array.isArray(t.history) || !t.history.every((s) => typeof s === 'string')) return false;
  if (typeof t.historyIndex !== 'number') return false;
  if (t.historyIndex < 0 || t.historyIndex >= t.history.length) return false;
  if (t.device !== undefined && !isDevice(t.device)) return false;
  if (t.targetDevice !== undefined && !isTargetDevice(t.targetDevice)) return false;
  if (t.pageZoom !== undefined && !isZoomFactor(t.pageZoom)) return false;
  if (t.canvasZoom !== undefined && !isZoomFactor(t.canvasZoom)) return false;
  if (t.pausedAt !== undefined && (typeof t.pausedAt !== 'number' || !Number.isFinite(t.pausedAt))) {
    return false;
  }
  return true;
}

function sanitize(value: unknown): BrowserCwdState {
  if (!value || typeof value !== 'object') return { ...EMPTY_STATE };
  const v = value as Record<string, unknown>;
  let tabs = Array.isArray(v.tabs)
    ? v.tabs.filter(isTab).map((tab): BrowserTab => {
        const historyStart = Math.max(0, tab.history.length - MAX_HISTORY);
        const history = tab.history
          .slice(historyStart)
          .map((url) => normalizeBrowserUrl(url.slice(0, MAX_URL_CHARS)));
        return {
        id: tab.id,
        title: tab.title.slice(0, MAX_TITLE_CHARS),
        history,
        historyIndex: Math.max(0, Math.min(history.length - 1, tab.historyIndex - historyStart)),
        ...(tab.device ? { device: { ...tab.device } } : {}),
        ...(tab.targetDevice ? { targetDevice: { ...tab.targetDevice } } : {}),
        ...(tab.pageZoom !== undefined ? { pageZoom: tab.pageZoom } : {}),
        ...(tab.canvasZoom !== undefined ? { canvasZoom: tab.canvasZoom } : {}),
        ...(tab.pausedAt !== undefined ? { pausedAt: tab.pausedAt } : {})
      };
      })
    : [];
  const rawActive = typeof v.activeTabId === 'string' ? v.activeTabId : null;
  if (tabs.length > MAX_PERSISTED_TABS) {
    const active = rawActive ? tabs.find((tab) => tab.id === rawActive) : undefined;
    tabs = tabs.slice(-MAX_PERSISTED_TABS);
    if (active && !tabs.some((tab) => tab.id === active.id)) {
      tabs = [active, ...tabs.slice(1)];
    }
  }
  const activeTabId = rawActive && tabs.some((t) => t.id === rawActive) ? rawActive : tabs[0]?.id ?? null;
  // Older/corrupt state could mark the active tab paused even though the UI
  // never permits it. Repair that invariant during migration.
  if (activeTabId) {
    tabs = tabs.map((tab) => {
      if (tab.id !== activeTabId || tab.pausedAt === undefined) return tab;
      const { pausedAt: _pausedAt, ...resumed } = tab;
      return resumed;
    });
  }
  return { tabs, activeTabId };
}

function newId(): string {
  return `tab-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function currentUrl(tab: BrowserTab): string {
  return tab.history[tab.historyIndex] ?? DEFAULT_URL;
}

export class BrowserStore {
  loaded = $state(false);
  private activeScope = $state<WorktreeScope | null>(null);
  private stateByScope = $state<Record<string, BrowserCwdState>>({});
  private legacyByCwd = $state<Record<string, BrowserCwdState>>({});
  // Renderer residency is intentionally transient: persistence describes user
  // intent, while these maps describe what is hot in this app process only.
  private recencyByScope = new Map<string, Map<string, number>>();
  private deferredByScope = new Map<string, Set<string>>();
  private closedTabsByScope = new Map<string, ClosedBrowserTab[]>();
  private recencyCounter = 0;
  private persistedScopeRecency: string[] = [];
  private pendingPersistenceKeys = new Set<string>();
  private persistenceHandle: ReturnType<typeof setTimeout> | null = null;
  private removeWholeStateAfterFlush = false;
  private loadPromise: Promise<void> | null = null;

  constructor(private readonly persistence: BrowserSessionPersistence | null = null) {
    this.loaded = persistence === null;
    if (typeof localStorage === 'undefined') return;
    try {
      const rawIndex = localStorage.getItem(STORAGE_INDEX_KEY);
      const parsedIndex = rawIndex ? JSON.parse(rawIndex) : [];
      if (Array.isArray(parsedIndex)) {
        const keys = parsedIndex
          .filter((key): key is string => typeof key === 'string')
          .slice(-MAX_PERSISTED_SCOPES);
        const next: Record<string, BrowserCwdState> = {};
        const validKeys: string[] = [];
        for (const key of keys) {
          try {
            const rawState = localStorage.getItem(scopeStorageKey(key));
            if (!rawState) continue;
            next[key] = sanitize(JSON.parse(rawState));
            validKeys.push(key);
          } catch {
            // One corrupt Worktree record cannot discard every other scope.
          }
        }
        this.stateByScope = next;
        this.persistedScopeRecency = validKeys;
      }
    } catch {
      // Corrupt entry — start fresh.
    }
    try {
      const raw = localStorage.getItem(WHOLE_STATE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const entries = Object.entries(parsed).slice(-MAX_PERSISTED_SCOPES);
        for (const [key, value] of entries) {
          if (this.stateByScope[key]) continue;
          this.stateByScope[key] = sanitize(value);
          this.markScopeRecent(key);
          this.pendingPersistenceKeys.add(key);
        }
        this.removeWholeStateAfterFlush = true;
        this.schedulePersistence();
      }
    } catch {
      // Corrupt v2 state is ignored; exact-scope v3 entries remain usable.
    }
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const next: Record<string, BrowserCwdState> = {};
        for (const [key, value] of Object.entries(parsed)) next[key] = sanitize(value);
        this.legacyByCwd = next;
      }
    } catch {
      // Corrupt legacy state remains unadopted.
    }
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.persistence) {
      this.loaded = true;
      return;
    }
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadFromDurableStorage();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async loadFromDurableStorage(): Promise<void> {
    const snapshot = await this.persistence!.load();
    const durableScopes: Record<string, BrowserCwdState> = {};
    for (const [key, state] of Object.entries(snapshot.scopes).slice(-MAX_PERSISTED_SCOPES)) {
      durableScopes[key] = sanitize(state);
    }
    const localScopes = this.stateByScope;
    const migratedKeys = Object.keys(localScopes).filter((key) => !durableScopes[key]);
    this.stateByScope = { ...localScopes, ...durableScopes };
    this.persistedScopeRecency = [
      ...snapshot.scopeRecency.filter((key) => key in durableScopes),
      ...this.persistedScopeRecency.filter((key) => !durableScopes[key])
    ].slice(-MAX_PERSISTED_SCOPES);
    for (const key of migratedKeys) this.pendingPersistenceKeys.add(key);
    this.loaded = true;
    if (this.pendingPersistenceKeys.size > 0 || this.removeWholeStateAfterFlush) {
      await this.flushPersistence();
    }
  }

  setActiveScope(scope: WorktreeScope | null | undefined): void {
    const next = scope?.cwd.trim() ? worktreeScope(scope.cwd, scope) : null;
    const previousKey = this.currentKey();
    const nextKey = next ? worktreeScopeKey(next) : NO_WORKTREE_KEY;
    if (nextKey === previousKey) return;
    this.releaseResidents();
    this.activeScope = next;
    this.seedLegacyForCurrentScope();
    this.releaseResidents();
  }

  private currentKey(): string {
    return this.activeScope ? worktreeScopeKey(this.activeScope) : NO_WORKTREE_KEY;
  }

  private current(): BrowserCwdState {
    return this.stateByScope[this.currentKey()] ?? EMPTY_STATE;
  }

  private write(next: BrowserCwdState): void {
    const key = this.currentKey();
    this.stateByScope[key] = next;
    this.pendingPersistenceKeys.add(key);
    this.markScopeRecent(key);
    this.schedulePersistence();
  }

  flushPersistence(): Promise<void> {
    if (this.persistenceHandle) {
      clearTimeout(this.persistenceHandle);
      this.persistenceHandle = null;
    }
    if (this.pendingPersistenceKeys.size === 0 && !this.removeWholeStateAfterFlush) {
      return Promise.resolve();
    }
    const pending = [...this.pendingPersistenceKeys];
    const durablePayloads = new Map<string, string>();
    for (const key of pending) {
      const state = this.stateByScope[key];
      if (state) durablePayloads.set(key, serializePersistedState(state));
    }
    this.pendingPersistenceKeys.clear();

    if (typeof localStorage !== 'undefined') {
      try {
        const { payloads: localPayloads, scopeRecency: localScopeRecency } =
          this.prepareLocalStoragePayloads(durablePayloads);
        if (this.removeWholeStateAfterFlush) {
          // The bounded v3 payload is held in memory. Free the legacy whole-world
          // allocation before writing so migration itself cannot double quota use.
          localStorage.removeItem(WHOLE_STATE_STORAGE_KEY);
        }
        for (const [key, payload] of localPayloads) {
          localStorage.setItem(scopeStorageKey(key), payload);
        }
        localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(localScopeRecency));
        if (this.removeWholeStateAfterFlush) this.removeWholeStateAfterFlush = false;
      } catch {
        // localStorage remains a migration/fallback copy; host persistence is authoritative.
      }
    }

    if (!this.persistence || !this.loaded || durablePayloads.size === 0) {
      return Promise.resolve();
    }
    const writes = [...durablePayloads].map(([scopeKey, payload]) =>
      this.persistence!.update({
        scopeKey,
        state: JSON.parse(payload) as BrowserCwdState
      })
    );
    return Promise.all(writes).then(
      () => undefined,
      () => {
        for (const key of durablePayloads.keys()) {
          if (this.stateByScope[key]) this.pendingPersistenceKeys.add(key);
        }
      }
    );
  }

  private schedulePersistence(): void {
    if (this.persistenceHandle) return;
    if (this.persistence && !this.loaded) return;
    if (typeof localStorage === 'undefined' && !this.persistence) return;
    this.persistenceHandle = setTimeout(() => {
      this.persistenceHandle = null;
      void this.flushPersistence();
    }, PERSIST_DELAY_MS);
  }

  private markScopeRecent(key: string): void {
    this.persistedScopeRecency = [
      ...this.persistedScopeRecency.filter((candidate) => candidate !== key),
      key
    ];
  }

  private prepareLocalStoragePayloads(
    pendingPayloads: ReadonlyMap<string, string>
  ): { payloads: Map<string, string>; scopeRecency: string[] } {
    this.prunePersistedScopeCount();
    const payloads = new Map(pendingPayloads);

    const retainedNewestFirst: string[] = [];
    let retainedChars = 0;
    for (let index = this.persistedScopeRecency.length - 1; index >= 0; index -= 1) {
      const key = this.persistedScopeRecency[index]!;
      const payload = payloads.get(key) ?? localStorage.getItem(scopeStorageKey(key));
      if (!payload) continue;
      if (retainedChars + payload.length > MAX_TOTAL_STORAGE_CHARS) {
        localStorage.removeItem(scopeStorageKey(key));
        payloads.delete(key);
        continue;
      }
      retainedNewestFirst.push(key);
      retainedChars += payload.length;
    }
    return { payloads, scopeRecency: retainedNewestFirst.reverse() };
  }

  private prunePersistedScopeCount(): void {
    while (this.persistedScopeRecency.length > MAX_PERSISTED_SCOPES) {
      const oldest = this.persistedScopeRecency.shift();
      if (!oldest) break;
      this.dropPersistedScope(oldest);
    }
  }

  private dropPersistedScope(key: string): void {
    localStorage.removeItem(scopeStorageKey(key));
    delete this.stateByScope[key];
    this.pendingPersistenceKeys.delete(key);
    this.recencyByScope.delete(key);
    this.deferredByScope.delete(key);
    this.closedTabsByScope.delete(key);
  }

  get tabs(): BrowserTab[] {
    return this.current().tabs;
  }

  get activeTabId(): string | null {
    return this.current().activeTabId;
  }

  get activeWorktreeKey(): string {
    return this.currentKey();
  }

  get activeTab(): BrowserTab | null {
    const state = this.current();
    if (!state.activeTabId) return null;
    return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  }

  get canRestoreClosedTab(): boolean {
    return (this.closedTabsByScope.get(this.currentKey())?.length ?? 0) > 0;
  }

  activeUrl(): string {
    const tab = this.activeTab;
    return tab ? currentUrl(tab) : DEFAULT_URL;
  }

  canGoBack(id: string): boolean {
    const tab = this.tabs.find((t) => t.id === id);
    return tab ? tab.historyIndex > 0 : false;
  }

  canGoForward(id: string): boolean {
    const tab = this.tabs.find((t) => t.id === id);
    return tab ? tab.historyIndex < tab.history.length - 1 : false;
  }

  addTab(url: string = DEFAULT_URL, targetDevice?: BrowserTargetDevice): BrowserTab {
    const id = newId();
    const tab: BrowserTab = {
      id,
      title: url,
      history: [url],
      historyIndex: 0,
      ...(targetDevice ? { targetDevice: { ...targetDevice } } : {})
    };
    const state = this.current();
    if (state.activeTabId) this.touch(state.activeTabId);
    this.write({ tabs: [...state.tabs, tab], activeTabId: id });
    this.touch(id);
    return tab;
  }

  duplicateTab(id: string): BrowserTab | null {
    const state = this.current();
    const idx = state.tabs.findIndex((tab) => tab.id === id);
    if (idx < 0) return null;
    const source = state.tabs[idx]!;
    const { pausedAt: _pausedAt, ...resumed } = source;
    const tab: BrowserTab = {
      ...resumed,
      id: newId(),
      history: [...source.history],
      ...(source.device ? { device: { ...source.device } } : {}),
      ...(source.targetDevice ? { targetDevice: { ...source.targetDevice } } : {})
    };
    const tabs = state.tabs.slice();
    tabs.splice(idx + 1, 0, tab);
    if (state.activeTabId) this.touch(state.activeTabId);
    this.write({ tabs, activeTabId: tab.id });
    this.touch(tab.id);
    return tab;
  }

  reorderTab(id: string, targetId: string, position: 'before' | 'after'): void {
    if (id === targetId) return;
    const state = this.current();
    const fromIndex = state.tabs.findIndex((tab) => tab.id === id);
    const targetIndex = state.tabs.findIndex((tab) => tab.id === targetId);
    if (fromIndex < 0 || targetIndex < 0) return;
    let insertionIndex = targetIndex + (position === 'after' ? 1 : 0);
    const tabs = state.tabs.slice();
    const [tab] = tabs.splice(fromIndex, 1);
    if (!tab) return;
    if (fromIndex < insertionIndex) insertionIndex -= 1;
    tabs.splice(insertionIndex, 0, tab);
    if (tabs.every((candidate, index) => candidate.id === state.tabs[index]?.id)) return;
    this.write({ ...state, tabs });
  }

  selectTab(id: string): void {
    const state = this.current();
    const idx = state.tabs.findIndex((tab) => tab.id === id);
    if (idx < 0) return;
    const tab = state.tabs[idx]!;
    if (state.activeTabId === id && tab.pausedAt === undefined) return;
    if (state.activeTabId) this.touch(state.activeTabId);
    const tabs = state.tabs.slice();
    const { pausedAt: _pausedAt, ...resumed } = tab;
    tabs[idx] = resumed;
    this.write({ tabs, activeTabId: id });
    this.touch(id);
  }

  closeTab(id: string): void {
    const state = this.current();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const closed = state.tabs[idx]!;
    const stack = this.closedTabsByScope.get(this.currentKey()) ?? [];
    stack.push({
      tab: {
        ...closed,
        history: [...closed.history],
        ...(closed.device ? { device: { ...closed.device } } : {}),
        ...(closed.targetDevice ? { targetDevice: { ...closed.targetDevice } } : {})
      },
      index: idx
    });
    if (stack.length > MAX_CLOSED_TABS) stack.splice(0, stack.length - MAX_CLOSED_TABS);
    this.closedTabsByScope.set(this.currentKey(), stack);
    const tabs = state.tabs.filter((t) => t.id !== id);
    let activeTabId = state.activeTabId;
    if (activeTabId === id) {
      activeTabId = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? tabs[0]?.id ?? null;
      const nextIdx = tabs.findIndex((tab) => tab.id === activeTabId);
      if (nextIdx >= 0) {
        const next = tabs[nextIdx]!;
        const { pausedAt: _pausedAt, ...resumed } = next;
        tabs[nextIdx] = resumed;
      }
    }
    this.write({ tabs, activeTabId });
    this.recencyForCurrent().delete(id);
    this.deferredForCurrent().delete(id);
    if (activeTabId) this.touch(activeTabId);
  }

  restoreClosedTab(): BrowserTab | null {
    const stack = this.closedTabsByScope.get(this.currentKey());
    const closed = stack?.pop();
    if (!closed) return null;
    if (stack?.length === 0) this.closedTabsByScope.delete(this.currentKey());
    const state = this.current();
    const { pausedAt: _pausedAt, ...resumed } = closed.tab;
    const tab: BrowserTab = {
      ...resumed,
      id: newId(),
      history: [...closed.tab.history],
      ...(closed.tab.device ? { device: { ...closed.tab.device } } : {}),
      ...(closed.tab.targetDevice
        ? { targetDevice: { ...closed.tab.targetDevice } }
        : {})
    };
    const tabs = state.tabs.slice();
    tabs.splice(Math.min(closed.index, tabs.length), 0, tab);
    if (state.activeTabId) this.touch(state.activeTabId);
    this.write({ tabs, activeTabId: tab.id });
    this.touch(tab.id);
    return tab;
  }

  // Records a fresh navigation (typed URL, link click, etc.). Truncates any
  // forward history past the current index, like a normal browser does.
  navigate(id: string, url: string): void {
    const state = this.current();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const prev = state.tabs[idx]!;
    if (currentUrl(prev) === url) return;
    const kept = prev.history.slice(0, prev.historyIndex + 1);
    kept.push(url);
    const trimmed = kept.length > MAX_HISTORY ? kept.slice(kept.length - MAX_HISTORY) : kept;
    const tabs = state.tabs.slice();
    tabs[idx] = {
      ...prev,
      history: trimmed,
      historyIndex: trimmed.length - 1,
      title: url
    };
    this.write({ ...state, tabs });
  }

  // Step backward in the persisted history stack and return the URL the
  // caller should load into the webview. Returns null if already at the
  // start.
  goBack(id: string): string | null {
    const state = this.current();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const prev = state.tabs[idx]!;
    if (prev.historyIndex === 0) return null;
    const nextIndex = prev.historyIndex - 1;
    const tabs = state.tabs.slice();
    tabs[idx] = { ...prev, historyIndex: nextIndex };
    this.write({ ...state, tabs });
    return prev.history[nextIndex] ?? null;
  }

  goForward(id: string): string | null {
    const state = this.current();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const prev = state.tabs[idx]!;
    if (prev.historyIndex >= prev.history.length - 1) return null;
    const nextIndex = prev.historyIndex + 1;
    const tabs = state.tabs.slice();
    tabs[idx] = { ...prev, historyIndex: nextIndex };
    this.write({ ...state, tabs });
    return prev.history[nextIndex] ?? null;
  }

  setTitle(id: string, title: string): void {
    const state = this.current();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const prev = state.tabs[idx]!;
    if (prev.title === title) return;
    const tabs = state.tabs.slice();
    tabs[idx] = { ...prev, title };
    this.write({ ...state, tabs });
  }

  setDevice(id: string, device: BrowserTabDevice | null): void {
    const state = this.current();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const prev = state.tabs[idx]!;
    const tabs = state.tabs.slice();
    if (device == null) {
      if (!prev.device) return;
      const { device: _omit, ...rest } = prev;
      tabs[idx] = rest;
    } else {
      tabs[idx] = { ...prev, device };
    }
    this.write({ ...state, tabs });
  }

  setTargetDevice(id: string, targetDevice: BrowserTargetDevice | null): void {
    const state = this.current();
    const idx = state.tabs.findIndex((tab) => tab.id === id);
    if (idx < 0) return;
    const previous = state.tabs[idx]!;
    const tabs = state.tabs.slice();
    if (targetDevice == null) {
      if (!previous.targetDevice) return;
      const { targetDevice: _omitted, ...rest } = previous;
      tabs[idx] = rest;
    } else {
      tabs[idx] = { ...previous, targetDevice: { ...targetDevice } };
    }
    this.write({ ...state, tabs });
  }

  setPageZoom(id: string, factor: number): void {
    this.setTabZoom(id, 'pageZoom', factor);
  }

  setCanvasZoom(id: string, factor: number): void {
    this.setTabZoom(id, 'canvasZoom', factor);
  }

  private setTabZoom(
    id: string,
    field: 'pageZoom' | 'canvasZoom',
    factor: number
  ): void {
    if (!isZoomFactor(factor)) return;
    const state = this.current();
    const idx = state.tabs.findIndex((tab) => tab.id === id);
    if (idx < 0) return;
    const prev = state.tabs[idx]!;
    const normalized = Math.round(factor * 1_000) / 1_000;
    if ((prev[field] ?? 1) === normalized) return;
    const tabs = state.tabs.slice();
    if (normalized === 1) {
      const { [field]: _omitted, ...rest } = prev;
      tabs[idx] = rest;
    } else {
      tabs[idx] = { ...prev, [field]: normalized };
    }
    this.write({ ...state, tabs });
  }

  rotateDevice(id: string): void {
    const state = this.current();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const prev = state.tabs[idx]!;
    if (!prev.device) return;
    const tabs = state.tabs.slice();
    tabs[idx] = { ...prev, device: { ...prev.device, rotated: !prev.device.rotated } };
    this.write({ ...state, tabs });
  }

  pauseTab(id: string): void {
    const state = this.current();
    if (state.activeTabId === id) return;
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const prev = state.tabs[idx]!;
    if (prev.pausedAt !== undefined) return;
    const tabs = state.tabs.slice();
    tabs[idx] = { ...prev, pausedAt: Date.now() };
    this.write({ ...state, tabs });
    this.recencyForCurrent().delete(id);
    this.deferredForCurrent().delete(id);
  }

  resumeTab(id: string, promote = true): void {
    const state = this.current();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const prev = state.tabs[idx]!;
    if (prev.pausedAt === undefined) return;
    const tabs = state.tabs.slice();
    const { pausedAt: _omit, ...rest } = prev;
    tabs[idx] = rest;
    this.write({ ...state, tabs });
    if (promote) {
      this.touch(id);
    } else {
      this.recencyForCurrent().delete(id);
      this.deferredForCurrent().add(id);
    }
  }

  isPaused(id: string): boolean {
    return this.tabs.find((t) => t.id === id)?.pausedAt !== undefined;
  }

  /**
   * Returns the bounded set of tabs allowed to own live webviews. The active
   * tab is invariantly resident; remaining slots go to the most recently
   * activated, non-manually-paused background tabs.
   */
  residentTabs(limit: number): BrowserTab[] {
    const state = this.current();
    const capacity = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;
    const deferred = this.deferredForCurrent();
    const eligible = state.tabs.filter(
      (tab) => tab.pausedAt === undefined && !deferred.has(tab.id)
    );

    const chosen = new Set<string>();
    const active = eligible.find((tab) => tab.id === state.activeTabId);
    if (active) chosen.add(active.id);
    const recency = this.recencyForCurrent();
    const background = eligible
      .filter((tab) => tab.id !== state.activeTabId && recency.has(tab.id))
      .sort((a, b) => (recency.get(b.id) ?? 0) - (recency.get(a.id) ?? 0));
    for (const tab of background) {
      if (chosen.size >= capacity) break;
      chosen.add(tab.id);
    }
    return state.tabs.filter((tab) => chosen.has(tab.id));
  }

  // Called when the Browser rail hides or changes worktrees. Logical tabs are
  // untouched; reopening starts with only the active guest resident.
  releaseResidents(): void {
    this.recencyByScope.delete(this.currentKey());
  }

  private touch(id: string): void {
    this.recencyForCurrent().set(id, ++this.recencyCounter);
    this.deferredForCurrent().delete(id);
  }

  private recencyForCurrent(): Map<string, number> {
    const key = this.currentKey();
    const existing = this.recencyByScope.get(key);
    if (existing) return existing;
    const created = new Map<string, number>();
    this.recencyByScope.set(key, created);
    return created;
  }

  private deferredForCurrent(): Set<string> {
    const key = this.currentKey();
    const existing = this.deferredByScope.get(key);
    if (existing) return existing;
    const created = new Set<string>();
    this.deferredByScope.set(key, created);
    return created;
  }

  // Convenience for callers that want a tab regardless of prior state. Used
  // by the rail tab on mount when no tabs exist yet.
  ensureSomeTab(url?: string): BrowserTab {
    const active = this.activeTab;
    if (active) return active;
    return this.addTab(url);
  }

  private seedLegacyForCurrentScope(): void {
    if (!this.activeScope) return;
    const key = this.currentKey();
    if (this.stateByScope[key]) return;
    const legacy = this.legacyByCwd[this.activeScope.cwd];
    if (!legacy) return;
    // Browser persistence contains URL/history intent, not executable
    // actions. Seed every exact runtime independently, then let v2 copies
    // diverge without assigning the path-only snapshot to one distribution.
    this.stateByScope = { ...this.stateByScope, [key]: sanitize(legacy) };
    this.pendingPersistenceKeys.add(key);
    this.markScopeRecent(key);
    this.schedulePersistence();
  }
}

export const browserStore = new BrowserStore({
  load: () => ipc.browserSessions.get(),
  update: (request) => ipc.browserSessions.update(request)
});
export { DEFAULT_URL as BROWSER_DEFAULT_URL };

function scopeStorageKey(scopeKey: string): string {
  return `${STORAGE_SCOPE_PREFIX}${scopeKey}`;
}

function serializePersistedState(state: BrowserCwdState): string {
  const sanitized = sanitize(state);
  let payload = JSON.stringify(sanitized);
  if (payload.length <= MAX_SCOPE_STORAGE_CHARS) return payload;

  const compactHistory = compactStateHistory(sanitized, 25, 2_048);
  payload = JSON.stringify(compactHistory);
  if (payload.length <= MAX_SCOPE_STORAGE_CHARS) return payload;

  return JSON.stringify(compactStateHistory(compactHistory, 1, 2_048));
}

function compactStateHistory(
  state: BrowserCwdState,
  historyLimit: number,
  urlLimit: number
): BrowserCwdState {
  return {
    activeTabId: state.activeTabId,
    tabs: state.tabs.map((tab) => {
      const start = Math.max(
        0,
        Math.min(tab.historyIndex - Math.floor(historyLimit / 2), tab.history.length - historyLimit)
      );
      const history = tab.history
        .slice(start, start + historyLimit)
        .map((url) => url.slice(0, urlLimit));
      return {
        ...tab,
        history,
        historyIndex: Math.max(0, Math.min(history.length - 1, tab.historyIndex - start))
      };
    })
  };
}
