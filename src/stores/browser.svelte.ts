export interface BrowserTabDevice {
  // Preset id from BROWSER_DEVICE_PRESETS, or 'custom' for ad-hoc sizes.
  presetId: string;
  // Logical (CSS-pixel) viewport, before rotation. `rotated` swaps these at
  // apply time so the user can flip between portrait and landscape without
  // editing the numbers themselves.
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  ua: string;
  rotated: boolean;
}

export interface BrowserTab {
  id: string;
  title: string;
  // Navigation stack — `history[historyIndex]` is the current URL. We keep
  // this in the store (not just relying on the webview's internal Chromium
  // history) so back/forward survive a full unmount of the browser tab.
  history: string[];
  historyIndex: number;
  // Per-tab device emulation. Undefined = native (no emulation).
  device?: BrowserTabDevice;
}

interface BrowserCwdState {
  tabs: BrowserTab[];
  activeTabId: string | null;
}

const NO_WORKTREE_KEY = '__none__';
const STORAGE_KEY = 'soloe.browser.v1';
const DEFAULT_URL = 'about:blank';
const MAX_HISTORY = 100;

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

function isTab(value: unknown): value is BrowserTab {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  if (typeof t.id !== 'string' || typeof t.title !== 'string') return false;
  if (!Array.isArray(t.history) || !t.history.every((s) => typeof s === 'string')) return false;
  if (typeof t.historyIndex !== 'number') return false;
  if (t.historyIndex < 0 || t.historyIndex >= t.history.length) return false;
  if (t.device !== undefined && !isDevice(t.device)) return false;
  return true;
}

function sanitize(value: unknown): BrowserCwdState {
  if (!value || typeof value !== 'object') return { ...EMPTY_STATE };
  const v = value as Record<string, unknown>;
  const tabs = Array.isArray(v.tabs) ? v.tabs.filter(isTab) : [];
  const rawActive = typeof v.activeTabId === 'string' ? v.activeTabId : null;
  const activeTabId = rawActive && tabs.some((t) => t.id === rawActive) ? rawActive : tabs[0]?.id ?? null;
  return { tabs, activeTabId };
}

function newId(): string {
  return `tab-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function currentUrl(tab: BrowserTab): string {
  return tab.history[tab.historyIndex] ?? DEFAULT_URL;
}

class BrowserStore {
  private activeCwd = $state<string | null>(null);
  private stateByCwd = $state<Record<string, BrowserCwdState>>({});

  constructor() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const next: Record<string, BrowserCwdState> = {};
      for (const [key, value] of Object.entries(parsed)) {
        next[key] = sanitize(value);
      }
      this.stateByCwd = next;
    } catch {
      // Corrupt entry — start fresh.
    }
  }

  setActiveCwd(cwd: string | null | undefined): void {
    const next = cwd && cwd.trim().length > 0 ? cwd.trim() : null;
    if (next === this.activeCwd) return;
    this.activeCwd = next;
  }

  private currentKey(): string {
    return this.activeCwd ?? NO_WORKTREE_KEY;
  }

  private current(): BrowserCwdState {
    return this.stateByCwd[this.currentKey()] ?? EMPTY_STATE;
  }

  private write(next: BrowserCwdState): void {
    this.stateByCwd[this.currentKey()] = next;
    this.persist();
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.stateByCwd));
    } catch {
      // Quota — ignore.
    }
  }

  get tabs(): BrowserTab[] {
    return this.current().tabs;
  }

  get activeTabId(): string | null {
    return this.current().activeTabId;
  }

  get activeTab(): BrowserTab | null {
    const state = this.current();
    if (!state.activeTabId) return null;
    return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
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

  addTab(url: string = DEFAULT_URL): BrowserTab {
    const id = newId();
    const tab: BrowserTab = { id, title: url, history: [url], historyIndex: 0 };
    const state = this.current();
    this.write({ tabs: [...state.tabs, tab], activeTabId: id });
    return tab;
  }

  selectTab(id: string): void {
    const state = this.current();
    if (state.activeTabId === id) return;
    if (!state.tabs.some((t) => t.id === id)) return;
    this.write({ ...state, activeTabId: id });
  }

  closeTab(id: string): void {
    const state = this.current();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tabs = state.tabs.filter((t) => t.id !== id);
    let activeTabId = state.activeTabId;
    if (activeTabId === id) {
      activeTabId = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? tabs[0]?.id ?? null;
    }
    this.write({ tabs, activeTabId });
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

  // Convenience for callers that want a tab regardless of prior state. Used
  // by the rail tab on mount when no tabs exist yet.
  ensureSomeTab(url?: string): BrowserTab {
    const active = this.activeTab;
    if (active) return active;
    return this.addTab(url);
  }
}

export const browserStore = new BrowserStore();
export { DEFAULT_URL as BROWSER_DEFAULT_URL };
