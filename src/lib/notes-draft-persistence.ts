import type { ProjectId } from '@shared/types/projects.js';

export type NotesDraftAddress =
  | { kind: 'project'; projectId: ProjectId }
  | { kind: 'worktree'; projectId: ProjectId; storageKey: string }
  | { kind: 'saved'; projectId: ProjectId; filename: string };

export interface LoadedNotesDrafts {
  byProject: Record<ProjectId, string>;
  byWorktree: Record<string, string>;
  bySaved: Record<string, string>;
}

const PROJECT_PREFIX = 'soloe.notes.draft.';
const WORKTREE_PREFIX = 'soloe.notes.draftByWorktree.';
const SAVED_PREFIX = 'soloe.notes.savedRecovery.';
const DEFAULT_FLUSH_DELAY_MS = 250;

/**
 * Owns restart-safe Notes draft persistence without putting synchronous
 * storage I/O on the textarea input path.
 */
export class NotesDraftPersistence {
  private readonly pending = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly storage: Storage | null = browserStorage(),
    private readonly flushDelayMs = DEFAULT_FLUSH_DELAY_MS
  ) {}

  load(): LoadedNotesDrafts {
    const byProject: Record<ProjectId, string> = {};
    const byWorktree: Record<string, string> = {};
    const bySaved: Record<string, string> = {};
    if (!this.storage) return { byProject, byWorktree, bySaved };
    try {
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index);
        if (!key) continue;
        if (key.startsWith(SAVED_PREFIX)) {
          const address = parseSavedStorageKey(key);
          const content = this.storage.getItem(key);
          if (address && content !== null) {
            bySaved[savedNoteRecoveryKey(address.projectId, address.filename)] = content;
          }
          continue;
        }
        if (key.startsWith(WORKTREE_PREFIX)) {
          const address = key.slice(WORKTREE_PREFIX.length);
          const content = this.storage.getItem(key);
          if (address.includes('::') && content) byWorktree[address] = content;
          continue;
        }
        if (!key.startsWith(PROJECT_PREFIX)) continue;
        const projectId = key.slice(PROJECT_PREFIX.length) as ProjectId;
        const content = this.storage.getItem(key);
        if (projectId && content) byProject[projectId] = content;
      }
    } catch {
      // Storage can be disabled; the Notes Module remains memory-backed.
    }
    return { byProject, byWorktree, bySaved };
  }

  schedule(address: NotesDraftAddress, content: string): void {
    if (!this.storage) return;
    const key = storageKey(address);
    this.pending.set(key, content);
    this.clearTimer(key);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.flushKey(key);
    }, Math.max(0, this.flushDelayMs));
    this.timers.set(key, timer);
  }

  remove(address: NotesDraftAddress): void {
    if (!this.storage) return;
    const key = storageKey(address);
    this.clearTimer(key);
    this.pending.delete(key);
    try {
      this.storage.removeItem(key);
    } catch {
      // Best effort; in-memory state remains authoritative for this process.
    }
  }

  flushAll(): void {
    for (const key of [...this.pending.keys()]) {
      this.clearTimer(key);
      this.flushKey(key);
    }
  }

  private flushKey(key: string): void {
    if (!this.storage || !this.pending.has(key)) return;
    const content = this.pending.get(key)!;
    try {
      if (content || key.startsWith(SAVED_PREFIX)) this.storage.setItem(key, content);
      else this.storage.removeItem(key);
      this.pending.delete(key);
    } catch {
      // Retain the latest pending value so a later explicit flush can retry.
    }
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(key);
  }
}

function storageKey(address: NotesDraftAddress): string {
  if (address.kind === 'worktree') return `${WORKTREE_PREFIX}${address.storageKey}`;
  if (address.kind === 'saved') {
    return `${SAVED_PREFIX}${encodeURIComponent(savedNoteRecoveryKey(address.projectId, address.filename))}`;
  }
  return `${PROJECT_PREFIX}${address.projectId}`;
}

export function savedNoteRecoveryKey(projectId: ProjectId, filename: string): string {
  return JSON.stringify([projectId, filename]);
}

function parseSavedStorageKey(
  storageKey: string
): { projectId: ProjectId; filename: string } | null {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(storageKey.slice(SAVED_PREFIX.length)));
    if (
      !Array.isArray(parsed)
      || parsed.length !== 2
      || typeof parsed[0] !== 'string'
      || typeof parsed[1] !== 'string'
      || !parsed[0]
      || !parsed[1]
    ) return null;
    return { projectId: parsed[0] as ProjectId, filename: parsed[1] };
  } catch {
    return null;
  }
}

function browserStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}
