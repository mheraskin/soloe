export type RailTabId = 'inspector' | 'notes' | 'diff' | 'files';

interface RailState {
  activeTab: RailTabId;
  open: boolean;
  // When true, the active rail tab stretches across the main area and
  // covers the terminal. Applies to whichever tab is active, not just diff.
  fullscreen: boolean;
}

const DEFAULT_STATE: RailState = {
  activeTab: 'inspector',
  open: false,
  fullscreen: false
};

// Bucket used when no worktree is active (e.g. no session selected). Lets the
// rail still behave like a single global state in that edge case.
const NO_WORKTREE_KEY = '__none__';
const STORAGE_KEY = 'soloe.rightRail.v1';
const DIFF_SCROLL_KEY = 'soloe.diffScroll.v1';
const FILES_SCROLL_KEY = 'soloe.filesScroll.v1';

function sanitize(value: Partial<RailState> | undefined): RailState {
  const raw = value?.activeTab;
  const tab: RailTabId =
    raw === 'notes' || raw === 'diff' || raw === 'files' ? raw : 'inspector';
  return {
    activeTab: tab,
    open: typeof value?.open === 'boolean' ? value.open : false,
    fullscreen: typeof value?.fullscreen === 'boolean' ? value.fullscreen : false
  };
}

class RightRailStore {
  // The store keys all of its visible state by worktree cwd. A consumer in
  // App.svelte feeds the active cwd in as `sessions.selected` changes, so we
  // don't have to import the sessions store from here (would be a cycle).
  private activeCwd = $state<string | null>(null);
  private stateByCwd = $state<Record<string, RailState>>({});

  // Diff viewport scroll position per worktree. Kept here rather than in
  // working-diff because the rail already owns per-cwd UI persistence and is
  // localStorage-backed; the diff body restores from this on cwd switch.
  // Plain (non-$state) record: writes happen on every scroll tick and we
  // don't want any subscribers reacting to that.
  private diffScrollByCwd: Record<string, number> = {};

  // Same idea for the files tab — but split by surface: the file tree's
  // scroll (no file open) and the editor's scroll (file open) are recorded
  // independently so coming back to either restores the right offset.
  private filesTreeScrollByCwd: Record<string, number> = {};
  private filesEditorScrollByCwd: Record<string, number> = {};

  constructor() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, Partial<RailState>>;
        const next: Record<string, RailState> = {};
        for (const [key, value] of Object.entries(parsed)) {
          next[key] = sanitize(value);
        }
        this.stateByCwd = next;
      }
    } catch {
      // Corrupt entry — start fresh; not worth surfacing to the user.
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

  get activeTab(): RailTabId {
    return this.current().activeTab;
  }

  get open(): boolean {
    return this.current().open;
  }
  set open(value: boolean) {
    // Closing the rail also clears fullscreen so reopening from a tab icon
    // doesn't snap straight back into the terminal-hiding mode.
    if (value) {
      this.patch({ open: true });
    } else {
      this.patch({ open: false, fullscreen: false });
    }
  }

  get fullscreen(): boolean {
    return this.current().fullscreen;
  }
  set fullscreen(value: boolean) {
    if (value) {
      this.patch({ fullscreen: true, open: true });
    } else {
      this.patch({ fullscreen: false });
    }
  }

  // Worktrees where the diff tab is the persisted active tab and the rail is
  // open. Used to keep RailDiffTab mounted for those worktrees across
  // worktree switches, so the diff body doesn't tear down and rebuild when
  // jumping back and forth.
  get diffMountedCwds(): string[] {
    const out: string[] = [];
    for (const [key, value] of Object.entries(this.stateByCwd)) {
      if (key === NO_WORKTREE_KEY) continue;
      if (value.open && value.activeTab === 'diff') out.push(key);
    }
    return out;
  }

  // Same mount-keep-alive idea for the files tab: any worktree whose
  // persisted choice is 'files' keeps RailFilesTab in the DOM so the tree's
  // expansion + the editor's scroll/cursor survive worktree hops.
  get filesMountedCwds(): string[] {
    const out: string[] = [];
    for (const [key, value] of Object.entries(this.stateByCwd)) {
      if (key === NO_WORKTREE_KEY) continue;
      if (value.open && value.activeTab === 'files') out.push(key);
    }
    return out;
  }

  openTab(tab: RailTabId): void {
    this.patch({ activeTab: tab, open: true });
  }

  toggleTab(tab: RailTabId): void {
    const state = this.current();
    if (state.open && state.activeTab === tab) {
      // Clicking the active tab in fullscreen drops back to the split
      // layout so the terminal becomes visible again, instead of closing
      // the rail outright.
      if (state.fullscreen) {
        this.patch({ fullscreen: false });
        return;
      }
      this.patch({ open: false, fullscreen: false });
      return;
    }
    this.patch({ activeTab: tab, open: true });
  }

  close(): void {
    this.patch({ open: false, fullscreen: false });
  }

  toggleFullscreen(): void {
    const state = this.current();
    this.patch({ fullscreen: !state.fullscreen, open: true });
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

  // Editor scroll is keyed by both cwd and relativePath so opening a second
  // file in the same worktree doesn't try to restore the first file's offset
  // into unrelated content. Callers compose the key as `${cwd}::${path}`.
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
