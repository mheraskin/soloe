// Persists which worktree groups are collapsed in the sidebar so the user's
// "hide this worktree I'm not touching" decisions survive reloads, and the
// Ctrl+1..9 numbering can renumber to only the visible (expanded) sessions.
// We store the deviation (collapsed cwds) rather than the expanded ones so a
// freshly-cloned worktree shows up open without any migration.

const STORAGE_KEY = 'soloe.sidebar.collapsedWorktrees.v1';

function normalize(cwd: string): string {
  return cwd.replace(/[/\\]+$/, '');
}

function loadCollapsed(): Record<string, true> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return {};
    const out: Record<string, true> = {};
    for (const item of parsed) {
      if (typeof item === 'string' && item.length > 0) out[normalize(item)] = true;
    }
    return out;
  } catch {
    return {};
  }
}

class SidebarExpansion {
  private collapsedCwds = $state<Record<string, true>>(loadCollapsed());

  isCollapsed(cwd: string): boolean {
    return this.collapsedCwds[normalize(cwd)] === true;
  }

  isExpanded(cwd: string): boolean {
    return !this.isCollapsed(cwd);
  }

  setExpanded(cwd: string, expanded: boolean): void {
    const key = normalize(cwd);
    const wasCollapsed = this.collapsedCwds[key] === true;
    if (expanded && wasCollapsed) {
      const next = { ...this.collapsedCwds };
      delete next[key];
      this.collapsedCwds = next;
      this.persist();
    } else if (!expanded && !wasCollapsed) {
      this.collapsedCwds = { ...this.collapsedCwds, [key]: true };
      this.persist();
    }
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.keys(this.collapsedCwds)));
    } catch {
      // Quota / serialization error — in-memory map still works for the session.
    }
  }
}

export const sidebarExpansion = new SidebarExpansion();
