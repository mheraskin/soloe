// Lightweight drag-state store used by the sidebar to coordinate sibling
// reordering across three nested levels (project → worktree → session).
//
// The actual data transfer goes through the HTML5 dataTransfer; this store
// only tracks the live drag for visual feedback (drop indicators, drag-over
// highlights) since dataTransfer payloads aren't readable during dragover.

export type DndKind = 'project' | 'worktree' | 'session';

export type DropPosition = 'before' | 'after';

interface DragState {
  kind: DndKind;
  // For project: project id.
  // For worktree: normalised cwd.
  // For session: session id.
  id: string;
  // Worktree drags carry the parent project id so cross-project drops can be
  // rejected at the renderer level (worktrees are git-bound to their repo).
  // Session drags carry both project id and worktree cwd to scope the drop.
  projectId: string | null;
  worktreeCwd: string | null;
}

interface DropTargetState {
  kind: DndKind;
  id: string;
  position: DropPosition;
}

class DndStore {
  drag = $state<DragState | null>(null);
  target = $state<DropTargetState | null>(null);

  begin(state: DragState): void {
    this.drag = state;
    this.target = null;
  }

  end(): void {
    this.drag = null;
    this.target = null;
  }

  setTarget(target: DropTargetState | null): void {
    this.target = target;
  }

  isDragging(kind: DndKind): boolean {
    return this.drag?.kind === kind;
  }
}

export const dnd = new DndStore();

export const DND_MIME = {
  project: 'application/x-soloe-project',
  worktree: 'application/x-soloe-worktree',
  session: 'application/x-soloe-session'
} as const;

// Decide which half of the row the cursor is over so we can show a drop line
// either above or below it.
export function dropPositionFromEvent(event: DragEvent, el: HTMLElement): DropPosition {
  const rect = el.getBoundingClientRect();
  const offsetY = event.clientY - rect.top;
  return offsetY < rect.height / 2 ? 'before' : 'after';
}
