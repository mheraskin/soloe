import type { FileDiff } from '@shared/types/git.js';

export type DiffSide = 'new' | 'old';
export type AnchorLineKind = 'context' | 'add' | 'remove';

// Snapshot of the diff lines a comment was anchored to at creation. Mirrors
// GitHub's diff_hunk + original_position model: when a later edit changes the
// content at the anchored line(s), the comment is flagged "outdated" rather
// than silently re-pointed at unrelated content.
export interface DiffCommentAnchor {
  // The exact text of every line covered by the comment range, in order.
  text: string[];
  // Up to ANCHOR_CONTEXT lines immediately preceding the range. May be empty
  // when the comment sits near the start of a hunk's context window.
  contextBefore: string[];
  // Up to ANCHOR_CONTEXT lines immediately following the range. May be empty
  // when the comment sits near the end of a hunk's context window.
  contextAfter: string[];
  // Per-line kind for the anchored range, in the same order as `text`.
  // Pre-existing records persisted before this field was introduced may omit
  // it — UI falls back to inferring from the comment's `side`.
  kinds?: AnchorLineKind[];
}

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
  // Optional — older comments persisted before anchors were introduced are
  // grandfathered as fresh and never flagged outdated.
  anchor?: DiffCommentAnchor;
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
const ANCHOR_CONTEXT = 3;

function fileKey(cwd: string, filePath: string): string {
  return `${cwd}::${filePath}`;
}

// Walk a FileDiff to collect the live (post-change for 'new', pre-change for
// 'old') line numbers paired with their text + kind. Add/remove lines from
// the opposite side are skipped — they don't carry a number on the requested
// side.
function collectLiveLines(
  diff: FileDiff,
  side: DiffSide
): Map<number, { text: string; kind: AnchorLineKind }> {
  const sideKey: 'oldLine' | 'newLine' = side === 'old' ? 'oldLine' : 'newLine';
  const out = new Map<number, { text: string; kind: AnchorLineKind }>();
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'meta') continue;
      if (side === 'new' && line.kind === 'remove') continue;
      if (side === 'old' && line.kind === 'add') continue;
      const num = line[sideKey];
      if (num === null) continue;
      out.set(num, { text: line.text, kind: line.kind });
    }
  }
  return out;
}

// Capture an anchor for the lines [startLine..endLine] on `side` from the
// current FileDiff. Returns null when the lines aren't present in any hunk
// (e.g. comments dropped on gap-expander rows whose content lives outside
// the diff). Such comments stay anchorless — they grandfather as fresh.
export function buildAnchorFromDiff(
  diff: FileDiff,
  side: DiffSide,
  startLine: number,
  endLine: number
): DiffCommentAnchor | null {
  const live = collectLiveLines(diff, side);
  const covered: string[] = [];
  const kinds: AnchorLineKind[] = [];
  for (let n = startLine; n <= endLine; n++) {
    const entry = live.get(n);
    if (entry === undefined) return null;
    covered.push(entry.text);
    kinds.push(entry.kind);
  }
  const before: string[] = [];
  for (let n = startLine - 1; n >= startLine - ANCHOR_CONTEXT && n > 0; n--) {
    const entry = live.get(n);
    if (entry === undefined) break;
    before.unshift(entry.text);
  }
  const after: string[] = [];
  for (let n = endLine + 1; n <= endLine + ANCHOR_CONTEXT; n++) {
    const entry = live.get(n);
    if (entry === undefined) break;
    after.push(entry.text);
  }
  return { text: covered, contextBefore: before, contextAfter: after, kinds };
}

// A comment is outdated when the live diff carries different text at its
// anchored coordinates. Lines that aren't present in any hunk match HEAD by
// definition — we treat that as fresh, since the snapshot was taken from the
// same file the diff is built from.
export function isCommentOutdated(comment: DiffComment, diff: FileDiff | null): boolean {
  const anchor = comment.anchor;
  if (!anchor || !diff) return false;
  const live = collectLiveLines(diff, comment.side);
  for (let i = 0; i < anchor.text.length; i++) {
    const num = comment.startLine + i;
    const liveEntry = live.get(num);
    if (liveEntry === undefined) continue;
    if (liveEntry.text !== anchor.text[i]) return true;
  }
  return false;
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

// Transient "flash this range" hint fired when the user jumps from the
// comments rail to the diff viewer. The viewer scrolls to the range and
// applies a fading background so the user can see which lines the comment
// is anchored to. Cleared automatically after a short interval.
export interface DiffCommentHighlight {
  cwd: string;
  filePath: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
  // Monotonic nonce — bumping it forces consumers to re-trigger even when
  // the user clicks the same comment twice in a row.
  nonce: number;
}

const HIGHLIGHT_DURATION_MS = 1600;

class DiffCommentsStore {
  byKey = $state<Record<string, DiffComment[]>>(loadFromStorage());
  selection = $state<DiffSelection | null>(null);
  // The comment id whose popover is open in edit mode. null when nothing is
  // being edited. A freshly-created comment from a drag selection sets this
  // so its marker renders the popover open immediately.
  editingId = $state<string | null>(null);
  // Recomputed whenever the active file's diff changes. Comments in this set
  // are filtered out of activeForFile (no gutter markers) and surfaced in the
  // rail's Outdated panel instead.
  outdatedIds = $state<Set<string>>(new Set());
  // Pending "flash this range" hint. The diff viewer picks it up via $effect.
  highlight = $state<DiffCommentHighlight | null>(null);
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;

  forFile(cwd: string, filePath: string): DiffComment[] {
    return this.byKey[fileKey(cwd, filePath)] ?? [];
  }

  // Default to active (unresolved + not-outdated) comments. The diff gutter
  // calls this to decide what to render — resolved ones live in the rail's
  // resolved panel, outdated ones in the rail's outdated panel.
  activeForFile(cwd: string, filePath: string): DiffComment[] {
    return this.forFile(cwd, filePath).filter(
      (c) => !c.resolvedAt && !this.outdatedIds.has(c.id)
    );
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

  // Outdated, but not resolved — a resolved comment lives in the resolved
  // panel regardless of whether the line was later edited away.
  outdatedForFile(cwd: string, filePath: string): DiffComment[] {
    return this.forFile(cwd, filePath).filter(
      (c) => !c.resolvedAt && this.outdatedIds.has(c.id)
    );
  }

  outdatedForWorktree(cwd: string): DiffComment[] {
    return this.forWorktree(cwd).filter(
      (c) => !c.resolvedAt && this.outdatedIds.has(c.id)
    );
  }

  forLine(cwd: string, filePath: string, side: DiffSide, line: number): DiffComment[] {
    return this.activeForFile(cwd, filePath).filter(
      (c) => c.side === side && c.startLine <= line && line <= c.endLine
    );
  }

  startSelection(cwd: string, filePath: string, side: DiffSide, line: number): void {
    // Discard any open draft that never got text typed into it. Without this,
    // clicking from one gutter row to another would leave behind a phantom
    // empty comment — the prior popover's outside-click handler can't clean
    // up because we're about to null out editingId, and its "remove on close"
    // guard reads editing as already-false by the time it fires.
    this.discardEmptyDraft();
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

  private discardEmptyDraft(): void {
    const id = this.editingId;
    if (!id) return;
    const draft = this.byId(id);
    if (!draft) return;
    if (draft.text.trim().length === 0) this.remove(id);
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

  endSelectionAndCreate(diff?: FileDiff | null): DiffComment | null {
    const sel = this.selection;
    if (!sel) return null;
    const anchor = diff
      ? buildAnchorFromDiff(diff, sel.side, sel.startLine, sel.endLine)
      : null;
    const comment: DiffComment = {
      id: crypto.randomUUID(),
      cwd: sel.cwd,
      filePath: sel.filePath,
      side: sel.side,
      startLine: sel.startLine,
      endLine: sel.endLine,
      text: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(anchor ? { anchor } : {})
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
      if (this.outdatedIds.has(id)) {
        const set = new Set(this.outdatedIds);
        set.delete(id);
        this.outdatedIds = set;
      }
      this.persist();
    }
  }

  setResolved(id: string, resolved: boolean): void {
    this.update(id, { resolvedAt: resolved ? Date.now() : undefined });
  }

  // Single mutation + single persist — N×setResolved would re-emit byKey and
  // hit disk on each call.
  setResolvedMany(ids: string[], resolved: boolean): void {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const resolvedAt = resolved ? Date.now() : undefined;
    const updatedAt = Date.now();
    let touched = false;
    const next: Record<string, DiffComment[]> = {};
    for (const [key, list] of Object.entries(this.byKey)) {
      const updated = list.map((c) => {
        if (!idSet.has(c.id)) return c;
        touched = true;
        return { ...c, resolvedAt, updatedAt };
      });
      next[key] = updated;
    }
    if (touched) {
      this.byKey = next;
      this.persist();
    }
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

  // Surface a transient highlight hint that the diff viewer translates into
  // a scroll-into-view + fade flash. Bumps a nonce so clicking the same
  // comment twice still re-triggers the flash; the auto-clear timer keeps
  // the highlight from sticking around.
  highlightLines(
    cwd: string,
    filePath: string,
    side: DiffSide,
    startLine: number,
    endLine: number
  ): void {
    if (this.highlightTimer) {
      clearTimeout(this.highlightTimer);
      this.highlightTimer = null;
    }
    const next: DiffCommentHighlight = {
      cwd,
      filePath,
      side,
      startLine,
      endLine,
      nonce: Date.now()
    };
    this.highlight = next;
    this.highlightTimer = setTimeout(() => {
      if (this.highlight && this.highlight.nonce === next.nonce) {
        this.highlight = null;
      }
      this.highlightTimer = null;
    }, HIGHLIGHT_DURATION_MS);
  }

  // Reconcile the outdated set for a single file against its current diff.
  // Comments without an anchor (older records or gap-row drops) are never
  // flagged. The effect calling this also reads `outdatedIds` (we iterate it
  // here), so a same-contents-new-Set write would re-fire the effect in a
  // loop — only assign when the set's contents have actually changed.
  recomputeOutdated(cwd: string, filePath: string, diff: FileDiff | null): void {
    const fileComments = this.forFile(cwd, filePath);
    if (fileComments.length === 0) return;
    const fileIds = new Set(fileComments.map((c) => c.id));
    const next = new Set<string>();
    for (const id of this.outdatedIds) {
      if (!fileIds.has(id)) next.add(id);
    }
    for (const c of fileComments) {
      if (isCommentOutdated(c, diff)) next.add(c.id);
    }
    if (next.size === this.outdatedIds.size) {
      let same = true;
      for (const id of next) {
        if (!this.outdatedIds.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.outdatedIds = next;
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
