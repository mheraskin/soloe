// Sidebar visibility (VS Code-style Ctrl+B). Persisted so the choice survives
// reloads, mirroring how the rail's per-worktree state is kept in localStorage.
const STORAGE_KEY = 'soloe.sidebar.hidden.v1';

class SidebarStore {
  hidden = $state(false);

  constructor() {
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
