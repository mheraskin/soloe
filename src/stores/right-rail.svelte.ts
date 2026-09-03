export type RailTabId = 'artifacts' | 'notes' | 'diff' | 'files' | 'feature' | 'browser';

// Maximum number of rail panes that can be open simultaneously. Two panes
// stack side-by-side in the rail; opening a third drops the oldest.
const MAX_OPEN_TABS = 2;

interface RailState {
  // Ordered list of currently open panes. Desktop exposes at most two;
  // mobile exposes only the most recent one.
  // Empty list means the rail is closed (only the icon column is visible).
  openTabs: RailTabId[];
  fullscreen: boolean;
  // Which pane the user is fullscreening. Always one of openTabs when
  // fullscreen is true; null when no pane is fullscreened.
  fullscreenTab: RailTabId | null;
}

const DEFAULT_STATE: RailState = {
  openTabs: [],
  fullscreen: false,
  fullscreenTab: null
};

const NO_WORKTREE_KEY = '__none__';
const STORAGE_KEY = 'soloe.rightRail.v2';
const LEGACY_STORAGE_KEY = 'soloe.rightRail.v1';
const DIFF_SCROLL_KEY = 'soloe.diffScroll.v1';
const FILES_SCROLL_KEY = 'soloe.filesScroll.v1';

const ALL_TABS: ReadonlySet<RailTabId> = new Set([
  'artifacts',
  'notes',
  'diff',
  'files',
  'feature',
  'browser'
]);

function sanitizeTabs(raw: unknown): RailTabId[] {
  if (!Array.isArray(raw)) return [];
  const out: RailTabId[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    if (!ALL_TABS.has(value as RailTabId)) continue;
    if (out.includes(value as RailTabId)) continue;
    out.push(value as RailTabId);
    if (out.length >= MAX_OPEN_TABS) break;
  }
  return out;
}

function sanitize(value: Partial<RailState> | undefined): RailState {
  const openTabs = sanitizeTabs(value?.openTabs);
  const fullscreenRaw = value?.fullscreenTab;
  const fullscreenTab =
    typeof fullscreenRaw === 'string' && openTabs.includes(fullscreenRaw as RailTabId)
      ? (fullscreenRaw as RailTabId)
      : null;
  return {
    openTabs,
    fullscreen: typeof value?.fullscreen === 'boolean' && openTabs.length > 0 ? value.fullscreen : false,
    fullscreenTab: typeof value?.fullscreen === 'boolean' && value.fullscreen ? fullscreenTab : null
  };
}

// One-shot migration from the v1 single-tab layout. The old shape was
// { activeTab, open, fullscreen }; if `open` was true we seed openTabs with
// that single tab so users don't lose their last selection on first load.
function migrateLegacy(raw: unknown): RailState | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const tab = obj.activeTab;
  if (typeof tab !== 'string' || !ALL_TABS.has(tab as RailTabId)) return null;
  const open = obj.open === true;
  const fullscreen = obj.fullscreen === true;
  if (!open) return { openTabs: [], fullscreen: false, fullscreenTab: null };
  const openTabs: RailTabId[] = [tab as RailTabId];
  return {
    openTabs,
    fullscreen,
    fullscreenTab: fullscreen ? (tab as RailTabId) : null
  };
}

export class RightRailStore {
  private activeCwd = $state<string | null>(null);
  private stateByCwd = $state<Record<string, RailState>>({});
  private paneLimit = $state<1 | 2>(2);

  // Transient: which pane slot (0 or 1) is currently highlighted by the
  // Ctrl+; cycle. Set when the cycle lands on a pane, cleared on the next
  // non-cycle keystroke so the ring doesn't linger while the user types.
  // Not persisted — it's purely visual state for the active cycle gesture.
  private focusedSlot = $state<0 | 1 | null>(null);

  private diffScrollByCwd: Record<string, number> = {};
  private filesTreeScrollByCwd: Record<string, number> = {};
  private filesEditorScrollByCwd: Record<string, number> = {};

  constructor() {
    if (typeof localStorage === 'undefined') return;
    let loaded = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, Partial<RailState>>;
        const next: Record<string, RailState> = {};
        for (const [key, value] of Object.entries(parsed)) {
          next[key] = sanitize(value);
        }
        this.stateByCwd = next;
        loaded = true;
      }
    } catch {
      // Corrupt entry — try legacy below.
    }
    if (!loaded) {
      try {
        const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const next: Record<string, RailState> = {};
          for (const [key, value] of Object.entries(parsed)) {
            const migrated = migrateLegacy(value);
            if (migrated) next[key] = migrated;
          }
          this.stateByCwd = next;
          this.persist();
        }
      } catch {
        // No legacy data either — start fresh.
      }
    }
    try {
      const raw = localStorage.getItem(DIFF_SCROLL_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const next: Record<string, number> = {};
        for (const [key, value] of Object.entries(parsed)) {
          const n = typeof value === 'number' ? value : Number(value);
          if (Number.isFinite(n) && n >= 0) next[key] = n;
        }
        this.diffScrollByCwd = next;
      }
    } catch {
      // Ignore — scroll position is recoverable.
    }
    try {
      const raw = localStorage.getItem(FILES_SCROLL_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          tree?: Record<string, unknown>;
          editor?: Record<string, unknown>;
        };
        const sanitize = (rec: Record<string, unknown> | undefined): Record<string, number> => {
          const next: Record<string, number> = {};
          if (!rec) return next;
          for (const [key, value] of Object.entries(rec)) {
            const n = typeof value === 'number' ? value : Number(value);
            if (Number.isFinite(n) && n >= 0) next[key] = n;
          }
          return next;
        };
        this.filesTreeScrollByCwd = sanitize(parsed.tree);
        this.filesEditorScrollByCwd = sanitize(parsed.editor);
      }
    } catch {
      // Ignore — scroll position is recoverable.
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

  private current(): RailState {
    return this.stateByCwd[this.currentKey()] ?? DEFAULT_STATE;
  }

  private visibleTabs(state = this.current()): RailTabId[] {
    return state.openTabs.slice(-this.paneLimit);
  }

  private patch(next: Partial<RailState>): void {
    const key = this.currentKey();
    const prev = this.stateByCwd[key] ?? DEFAULT_STATE;
    this.stateByCwd[key] = { ...prev, ...next };
    this.persist();
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.stateByCwd));
    } catch {
      // Quota or serialization error — ignore.
    }
  }

  // Convenience for consumers that only care whether the rail is showing
  // any pane at all.
  get open(): boolean {
    return this.visibleTabs().length > 0;
  }

  get openTabs(): readonly RailTabId[] {
    return this.visibleTabs();
  }

  setPaneLimit(limit: 1 | 2): void {
    if (limit === this.paneLimit) return;
    this.paneLimit = limit;
    const state = this.current();
    const visible = this.visibleTabs(state);
    if (
      state.fullscreen &&
      state.fullscreenTab !== null &&
      !visible.includes(state.fullscreenTab)
    ) {
      this.patch({ fullscreenTab: visible[visible.length - 1] ?? null });
    }
  }

  // The "primary" tab — the most-recently opened pane. Components that
  // previously checked rightRail.activeTab can keep working; this points
  // at whatever was last clicked, which matches the v1 behaviour when
  // only one pane could ever be open.
  get activeTab(): RailTabId {
    const tabs = this.visibleTabs();
    return tabs[tabs.length - 1] ?? 'diff';
  }

  get fullscreen(): boolean {
    return this.current().fullscreen;
  }
  set fullscreen(value: boolean) {
    const state = this.current();
    if (value) {
      const tabs = this.visibleTabs(state);
      if (tabs.length === 0) return;
      // Fullscreen targets the latest pane by default.
      const target =
        state.fullscreenTab && tabs.includes(state.fullscreenTab)
          ? state.fullscreenTab
          : tabs[tabs.length - 1];
      this.patch({ fullscreen: true, fullscreenTab: target });
    } else {
      this.patch({ fullscreen: false, fullscreenTab: null });
    }
  }

  // The pane that is currently fullscreened, or null when not in fullscreen.
  get fullscreenTab(): RailTabId | null {
    const state = this.current();
    if (!state.fullscreen) return null;
    const tabs = this.visibleTabs(state);
    return state.fullscreenTab && tabs.includes(state.fullscreenTab)
      ? state.fullscreenTab
      : (tabs[tabs.length - 1] ?? null);
  }

  openTab(tab: RailTabId): void {
    const state = this.current();
    const idx = state.openTabs.indexOf(tab);
    if (idx !== -1) {
      // Already open — promote to "most recent" so the next fullscreen
      // toggle targets it. Position rearranges if the user clicked an
      // older pane to bring it forward.
      const next = [...state.openTabs.filter((t) => t !== tab), tab].slice(-this.paneLimit);
      this.patch({ openTabs: next });
      return;
    }
    let next = [...state.openTabs, tab];
    if (next.length > this.paneLimit) next = next.slice(-this.paneLimit);
    this.patch({ openTabs: next });
  }

  openFullscreenTab(tab: RailTabId): void {
    const state = this.current();
    const openTabs = [...state.openTabs.filter((candidate) => candidate !== tab), tab]
      .slice(-this.paneLimit);
    this.patch({ openTabs, fullscreen: true, fullscreenTab: tab });
  }

  toggleFullscreenTab(tab: RailTabId): void {
    const state = this.current();
    if (state.openTabs.includes(tab)) {
      this.toggleTab(tab);
      return;
    }
    this.openFullscreenTab(tab);
  }

  toggleTab(tab: RailTabId): void {
    const state = this.current();
    // Per user feedback (2026-05-20): clicking any rail icon while a pane
    // is fullscreened closes the rail entirely rather than dropping back
    // to the split view. The next click reopens in normal mode because
    // openTabs starts empty.
    if (state.fullscreen) {
      this.patch({ openTabs: [], fullscreen: false, fullscreenTab: null });
      return;
    }
    const idx = state.openTabs.indexOf(tab);
    if (idx !== -1) {
      const next =
        this.paneLimit === 1 ? [] : state.openTabs.filter((t) => t !== tab);
      this.patch({ openTabs: next });
      return;
    }
    let next = [...state.openTabs, tab];
    if (next.length > this.paneLimit) next = next.slice(-this.paneLimit);
    this.patch({ openTabs: next });
  }

  close(): void {
    this.patch({ openTabs: [], fullscreen: false, fullscreenTab: null });
  }

  toggleFullscreen(): void {
    const state = this.current();
    const tabs = this.visibleTabs(state);
    if (tabs.length === 0) return;
    if (state.fullscreen) {
      this.patch({ fullscreen: false, fullscreenTab: null });
      return;
    }
    const target = tabs[tabs.length - 1];
    this.patch({ fullscreen: true, fullscreenTab: target });
  }

  get focusedPaneSlot(): 0 | 1 | null {
    return this.focusedSlot;
  }
  set focusedPaneSlot(slot: 0 | 1 | null) {
    if (slot !== null) {
      const tabs = this.current().openTabs;
      if (slot >= tabs.length) {
        this.focusedSlot = null;
        return;
      }
    }
    this.focusedSlot = slot;
  }

  // Pick which pane to fullscreen when the user has two open and wants to
  // promote one explicitly (e.g., via a per-pane fullscreen toggle).
  setFullscreenTab(tab: RailTabId): void {
    if (!this.visibleTabs().includes(tab)) return;
    this.patch({ fullscreen: true, fullscreenTab: tab });
  }

  getDiffScrollTop(cwd: string | null | undefined): number {
    if (!cwd) return 0;
    return this.diffScrollByCwd[cwd] ?? 0;
  }

  setDiffScrollTop(cwd: string | null | undefined, value: number): void {
    if (!cwd) return;
    const clamped = Math.max(0, Math.round(value));
    if (this.diffScrollByCwd[cwd] === clamped) return;
    this.diffScrollByCwd[cwd] = clamped;
    this.persistDiffScroll();
  }

  private persistDiffScroll(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(DIFF_SCROLL_KEY, JSON.stringify(this.diffScrollByCwd));
    } catch {
      // Quota — ignore; in-memory map still works for the session.
    }
  }

  getFilesTreeScrollTop(cwd: string | null | undefined): number {
    if (!cwd) return 0;
    return this.filesTreeScrollByCwd[cwd] ?? 0;
  }

  setFilesTreeScrollTop(cwd: string | null | undefined, value: number): void {
    if (!cwd) return;
    const clamped = Math.max(0, Math.round(value));
    if (this.filesTreeScrollByCwd[cwd] === clamped) return;
    this.filesTreeScrollByCwd[cwd] = clamped;
    this.persistFilesScroll();
  }

  getFilesEditorScrollTop(key: string | null | undefined): number {
    if (!key) return 0;
    return this.filesEditorScrollByCwd[key] ?? 0;
  }

  setFilesEditorScrollTop(key: string | null | undefined, value: number): void {
    if (!key) return;
    const clamped = Math.max(0, Math.round(value));
    if (this.filesEditorScrollByCwd[key] === clamped) return;
    this.filesEditorScrollByCwd[key] = clamped;
    this.persistFilesScroll();
  }

  private persistFilesScroll(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        FILES_SCROLL_KEY,
        JSON.stringify({ tree: this.filesTreeScrollByCwd, editor: this.filesEditorScrollByCwd })
      );
    } catch {
      // Quota — ignore.
    }
  }
}

export const rightRail = new RightRailStore();
