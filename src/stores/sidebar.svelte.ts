// Sidebar visibility (VS Code-style Ctrl+B). Persisted so the choice survives
// reloads, mirroring how the rail's per-worktree state is kept in localStorage.
const STORAGE_KEY = 'soloe.sidebar.hidden.v1';
// v2 bumped to reset legacy 260px widths onto the new 30% viewport default.
const WIDTH_KEY = 'soloe.sidebarWidth.v2';

// Shared with Sidebar.svelte. Kept in the store so the rail can clamp its
// own resize against the sidebar's effective width without measuring DOM.
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 460;
// Default sidebar width as a ratio of viewport, capped at SIDEBAR_MAX_WIDTH.
// Pairs with the rail's 30/40/30 default so the three columns feel balanced
// on first run.
const SIDEBAR_DEFAULT_RATIO = 0.30;
const SIDEBAR_FALLBACK_WIDTH = 320;

function computeDefaultWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_FALLBACK_WIDTH;
  const target = Math.round(window.innerWidth * SIDEBAR_DEFAULT_RATIO);
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, target));
}

function readStoredWidth(): number {
  if (typeof localStorage === 'undefined') return computeDefaultWidth();
  const raw = Number(localStorage.getItem(WIDTH_KEY));
  if (!Number.isFinite(raw)) return computeDefaultWidth();
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(raw)));
}

class SidebarStore {
  hidden = $state(false);
  width = $state(SIDEBAR_FALLBACK_WIDTH);

  constructor() {
    this.width = readStoredWidth();
    if (typeof localStorage === 'undefined') return;
    try {
      this.hidden = localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      // Ignore — assume visible.
    }
  }

  toggle(): void {
    this.hidden = !this.hidden;
    this.persist();
  }

  show(): void {
    if (!this.hidden) return;
    this.hidden = false;
    this.persist();
  }

  hide(): void {
    if (this.hidden) return;
    this.hidden = true;
    this.persist();
  }

  setWidth(value: number): void {
    const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
    if (clamped === this.width) return;
    this.width = clamped;
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch {
      // Quota — ignore.
    }
  }

  // What the sidebar actually contributes to the layout. Hidden sidebars
  // collapse to zero so the rail can compute its own max width.
  get effectiveWidth(): number {
    return this.hidden ? 0 : this.width;
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, String(this.hidden));
    } catch {
      // Quota — ignore.
    }
  }
}

export const sidebar = new SidebarStore();
