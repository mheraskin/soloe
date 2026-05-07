export type DiffSide = 'new' | 'old';

export interface DiffComment {
  id: string;
  cwd: string;
  filePath: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
  text: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  sentAt?: number;
}

export interface DiffSelection {
  cwd: string;
  filePath: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
  anchorLine: number;
  dragging: boolean;
}

const STORAGE_KEY = 'soloe.diffComments.v1';

function fileKey(cwd: string, filePath: string): string {
  return `${cwd}::${filePath}`;
}

function loadFromStorage(): Record<string, DiffComment[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, DiffComment[]> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(value)) out[key] = value as DiffComment[];
      }
      return out;
    }
  } catch {
    // ignore corrupt storage
  }
  return {};
}

class DiffCommentsStore {
  byKey = $state<Record<string, DiffComment[]>>(loadFromStorage());
  selection = $state<DiffSelection | null>(null);
  // The comment id whose popover is open in edit mode. null when nothing is
  // being edited. A freshly-created comment from a drag selection sets this
  // so its marker renders the popover open immediately.
  editingId = $state<string | null>(null);

  forFile(cwd: string, filePath: string): DiffComment[] {
    return this.byKey[fileKey(cwd, filePath)] ?? [];
  }

  // Default to active (unresolved) comments. The diff gutter calls this to
  // decide what to render — resolved comments live in the rail's resolved
  // panel and shouldn't crowd the line view.
  activeForFile(cwd: string, filePath: string): DiffComment[] {
    return this.forFile(cwd, filePath).filter((c) => !c.resolvedAt);
  }

  forWorktree(cwd: string): DiffComment[] {
    const out: DiffComment[] = [];
    const prefix = `${cwd}::`;
    for (const [key, list] of Object.entries(this.byKey)) {
      if (key.startsWith(prefix)) out.push(...list);
    }
    return out;
  }

  resolvedForWorktree(cwd: string): DiffComment[] {
    return this.forWorktree(cwd).filter((c) => c.resolvedAt);
  }

  forLine(cwd: string, filePath: string, side: DiffSide, line: number): DiffComment[] {
    return this.activeForFile(cwd, filePath).filter(
      (c) => c.side === side && c.startLine <= line && line <= c.endLine
    );
  }

  startSelection(cwd: string, filePath: string, side: DiffSide, line: number): void {
    this.selection = {
      cwd,
      filePath,
      side,
      startLine: line,
      endLine: line,
      anchorLine: line,
      dragging: true
    };
    this.editingId = null;
  }

  extendSelection(side: DiffSide, line: number): void {
    const sel = this.selection;
    if (!sel || !sel.dragging) return;
    // Lock to the side the drag started on. Mid-drag side flips would force
    // ambiguous comment anchoring; we just ignore them.
    if (side !== sel.side) return;
    const anchor = sel.anchorLine;
    this.selection = {
      ...sel,
      startLine: Math.min(anchor, line),
      endLine: Math.max(anchor, line)
    };
  }

  endSelectionAndCreate(): DiffComment | null {
    const sel = this.selection;
    if (!sel) return null;
    const comment: DiffComment = {
      id: crypto.randomUUID(),
      cwd: sel.cwd,
      filePath: sel.filePath,
      side: sel.side,
      startLine: sel.startLine,
      endLine: sel.endLine,
      text: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.add(comment);
    this.selection = null;
    this.editingId = comment.id;
    return comment;
  }

  cancelSelection(): void {
    this.selection = null;
  }

  add(comment: DiffComment): void {
    const key = fileKey(comment.cwd, comment.filePath);
    const list = this.byKey[key] ?? [];
    this.byKey = { ...this.byKey, [key]: [...list, comment] };
    this.persist();
  }

  update(id: string, patch: Partial<Omit<DiffComment, 'id' | 'cwd' | 'filePath' | 'createdAt'>>): void {
    let touched = false;
    const next: Record<string, DiffComment[]> = {};
    for (const [key, list] of Object.entries(this.byKey)) {
      const updated = list.map((c) => {
        if (c.id !== id) return c;
        touched = true;
        return { ...c, ...patch, updatedAt: Date.now() };
      });
      next[key] = updated;
    }
    if (touched) {
      this.byKey = next;
      this.persist();
    }
  }

  remove(id: string): void {
    let touched = false;
    const next: Record<string, DiffComment[]> = {};
    for (const [key, list] of Object.entries(this.byKey)) {
      const filtered = list.filter((c) => c.id !== id);
      if (filtered.length !== list.length) touched = true;
      next[key] = filtered;
    }
    if (touched) {
      this.byKey = next;
      if (this.editingId === id) this.editingId = null;
      this.persist();
    }
  }

  setResolved(id: string, resolved: boolean): void {
    this.update(id, { resolvedAt: resolved ? Date.now() : undefined });
  }

  beginEdit(id: string): void {
    this.editingId = id;
  }

  closeEditor(): void {
    this.editingId = null;
  }

  byId(id: string): DiffComment | null {
    for (const list of Object.values(this.byKey)) {
      const found = list.find((c) => c.id === id);
      if (found) return found;
    }
    return null;
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.byKey));
    } catch {
      // localStorage may be full or disabled; the in-memory state still works
    }
  }
}

export const diffComments = new DiffCommentsStore();
