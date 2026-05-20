import type { ProjectId } from '@shared/types/projects.js';
import type { NoteImage, NoteImagePayload, NoteSummary } from '@shared/types/notes.js';
import { ipc } from '../lib/ipc';
import { sessions } from './sessions.svelte';
import { settings } from './settings.svelte';

export type NotesStatus = 'idle' | 'saving' | 'saved' | 'error';

// Per-project draft persistence. Drafts are scratch space — they survive app
// restarts in localStorage so a half-written note isn't lost just because the
// user closed the window before saving to disk. The key prefix is namespaced
// so projects can't collide. Removed on save/discard.
const DRAFT_KEY_PROJECT_PREFIX = 'soloe.notes.draft.';

// Per-worktree draft persistence. Used when `settings.notes.draftsPerWorktree`
// is on. Key composes projectId and cwd; treated as opaque (never split back).
// Project IDs are slugged at creation, so this stays unambiguous even when cwd
// contains spaces.
const DRAFT_KEY_WORKTREE_PREFIX = 'soloe.notes.draftByWorktree.';

function worktreeDraftStorageKey(projectId: ProjectId, cwd: string): string {
  return `${projectId}::${cwd}`;
}

// Per-worktree memory of which saved note was last open. Notes live at the
// project level (shared across worktrees) but each worktree should restore the
// selection it had before the user navigated away. Keyed by cwd so the memory
// is independent of any session id; pairs the filename with the projectId so a
// stale entry (cwd later opened under a different project) can't surface the
// wrong note.
const VIEW_KEY_PREFIX = 'soloe.notes.viewByWorktree.';

interface WorktreeViewEntry {
  projectId: ProjectId;
  filename: string;
}

function loadViewsFromStorage(): Record<string, WorktreeViewEntry> {
  if (typeof localStorage === 'undefined') return {};
  const result: Record<string, WorktreeViewEntry> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(VIEW_KEY_PREFIX)) continue;
      const cwd = key.slice(VIEW_KEY_PREFIX.length);
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as { projectId?: unknown }).projectId === 'string' &&
          typeof (parsed as { filename?: unknown }).filename === 'string'
        ) {
          const entry = parsed as WorktreeViewEntry;
          result[cwd] = { projectId: entry.projectId, filename: entry.filename };
        }
      } catch {
        // skip malformed entries
      }
    }
  } catch {
    // Storage disabled. Memory stays in-process only.
  }
  return result;
}

function persistViewSelection(
  cwd: string,
  entry: WorktreeViewEntry | null
): void {
  if (typeof localStorage === 'undefined') return;
  const key = VIEW_KEY_PREFIX + cwd;
  try {
    if (entry) localStorage.setItem(key, JSON.stringify(entry));
    else localStorage.removeItem(key);
  } catch {
    // Quota / private mode — best effort.
  }
}

function loadProjectDraftsFromStorage(): Record<ProjectId, string> {
  if (typeof localStorage === 'undefined') return {};
  const result: Record<ProjectId, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(DRAFT_KEY_PROJECT_PREFIX)) continue;
      // Skip the worktree prefix, which begins with the project prefix string.
      if (key.startsWith(DRAFT_KEY_WORKTREE_PREFIX)) continue;
      const value = localStorage.getItem(key);
      if (value !== null && value.length > 0) {
        const projectId = key.slice(DRAFT_KEY_PROJECT_PREFIX.length) as ProjectId;
        result[projectId] = value;
      }
    }
  } catch {
    // Storage disabled (private mode / quota). Drafts stay in-memory only.
  }
  return result;
}

function persistProjectDraft(projectId: ProjectId, content: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (content.length > 0) {
      localStorage.setItem(DRAFT_KEY_PROJECT_PREFIX + projectId, content);
    } else {
      localStorage.removeItem(DRAFT_KEY_PROJECT_PREFIX + projectId);
    }
  } catch {
    // Quota / private mode — silently fall back to in-memory only.
  }
}

function clearStoredProjectDraft(projectId: ProjectId): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(DRAFT_KEY_PROJECT_PREFIX + projectId);
  } catch {
    // No-op.
  }
}

function loadWorktreeDraftsFromStorage(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  const result: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(DRAFT_KEY_WORKTREE_PREFIX)) continue;
      const value = localStorage.getItem(key);
      if (value !== null && value.length > 0) {
        const storageKey = key.slice(DRAFT_KEY_WORKTREE_PREFIX.length);
        if (storageKey.includes('::')) result[storageKey] = value;
      }
    }
  } catch {
    // Storage disabled. In-memory only.
  }
  return result;
}

function persistWorktreeDraft(storageKey: string, content: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (content.length > 0) {
      localStorage.setItem(DRAFT_KEY_WORKTREE_PREFIX + storageKey, content);
    } else {
      localStorage.removeItem(DRAFT_KEY_WORKTREE_PREFIX + storageKey);
    }
  } catch {
    // No-op.
  }
}

function clearStoredWorktreeDraft(storageKey: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(DRAFT_KEY_WORKTREE_PREFIX + storageKey);
  } catch {
    // No-op.
  }
}

class NotesStoreClass {
  listsByProject = $state<Record<ProjectId, NoteSummary[]>>({});
  loadedProjects = $state<Record<ProjectId, boolean>>({});

  draftsByProject = $state<Record<ProjectId, string>>(loadProjectDraftsFromStorage());

  // Drafts persisted per (project, worktree-cwd) when settings.notes
  // .draftsPerWorktree is on. Key = worktreeDraftStorageKey(projectId, cwd).
  draftsByWorktree = $state<Record<string, string>>(loadWorktreeDraftsFromStorage());

  // null view = draft is showing, string = saved-note filename
  viewByProject = $state<Record<ProjectId, string | null>>({});

  // Persisted per-worktree memory of which saved note was last open. Read by
  // restoreForActiveWorktree() to bring the editor back to the user's previous
  // selection when they re-activate a worktree.
  viewByWorktree = $state<Record<string, WorktreeViewEntry>>(loadViewsFromStorage());

  savedContentByProject = $state<Record<ProjectId, string>>({});
  savedDiskByProject = $state<Record<ProjectId, string>>({});

  statusByProject = $state<Record<ProjectId, NotesStatus>>({});
  errorMessageByProject = $state<Record<ProjectId, string | null>>({});

  activeProjectId = $derived<ProjectId | null>(sessions.selected?.projectId ?? null);
  activeWorktreeCwd = $derived<string | null>(sessions.selected?.cwd ?? null);

  notes = $derived<NoteSummary[]>(
    this.activeProjectId ? this.listsByProject[this.activeProjectId] ?? [] : []
  );

  view = $derived<string | null>(
    this.activeProjectId ? this.viewByProject[this.activeProjectId] ?? null : null
  );

  isDraft = $derived<boolean>(this.activeProjectId !== null && this.view === null);

  selectedFilename = $derived<string | null>(this.view);

  draftContent = $derived<string>(this.readActiveDraft());

  savedContent = $derived<string>(
    this.activeProjectId ? this.savedContentByProject[this.activeProjectId] ?? '' : ''
  );

  savedDirty = $derived<boolean>(
    this.activeProjectId
      ? (this.savedContentByProject[this.activeProjectId] ?? '') !==
        (this.savedDiskByProject[this.activeProjectId] ?? '')
      : false
  );

  status = $derived<NotesStatus>(
    this.activeProjectId ? this.statusByProject[this.activeProjectId] ?? 'idle' : 'idle'
  );

  errorMessage = $derived<string | null>(
    this.activeProjectId ? this.errorMessageByProject[this.activeProjectId] ?? null : null
  );

  loaded = $derived<boolean>(
    this.activeProjectId ? this.loadedProjects[this.activeProjectId] === true : false
  );

  private detachers: Array<() => void> = [];

  attachListeners(): void {
    this.detach();
    this.detachers.push(
      ipc.notes.onChange((event) => {
        this.listsByProject = { ...this.listsByProject, [event.projectId]: event.notes };
        this.loadedProjects = { ...this.loadedProjects, [event.projectId]: true };
        const known = new Set(event.notes.map((n) => n.filename));
        const activeFilename = this.viewByProject[event.projectId];
        if (activeFilename && !known.has(activeFilename)) {
          // selected note was deleted/renamed externally; revert to draft
          this.viewByProject = { ...this.viewByProject, [event.projectId]: null };
          this.savedContentByProject = { ...this.savedContentByProject, [event.projectId]: '' };
          this.savedDiskByProject = { ...this.savedDiskByProject, [event.projectId]: '' };
        }
        // Drop any worktree memory pointing at notes that no longer exist for
        // this project, so a future worktree switch doesn't try to reload a
        // file that's gone.
        this.dropWorktreeMemoryFor(event.projectId, (filename) => !known.has(filename));
      })
    );
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
  }

  async ensureLoaded(projectId: ProjectId): Promise<void> {
    if (this.loadedProjects[projectId]) return;
    await this.refresh(projectId);
  }

  async refresh(projectId: ProjectId): Promise<void> {
    const list = await ipc.notes.list(projectId);
    this.listsByProject = { ...this.listsByProject, [projectId]: list };
    this.loadedProjects = { ...this.loadedProjects, [projectId]: true };
  }

  newDraft(): void {
    const id = this.activeProjectId;
    if (!id) return;
    this.viewByProject = { ...this.viewByProject, [id]: null };
    this.statusByProject = { ...this.statusByProject, [id]: 'idle' };
    this.errorMessageByProject = { ...this.errorMessageByProject, [id]: null };
    if (!this.hasActiveDraft()) this.writeActiveDraft('');
    this.rememberSelection(null);
  }

  discardDraft(): void {
    const id = this.activeProjectId;
    if (!id) return;
    this.clearActiveDraft();
    void this.cleanupImages(id);
  }

  updateDraftContent(content: string): void {
    const id = this.activeProjectId;
    if (!id) return;
    this.writeActiveDraft(content);
  }

  // Wipes whatever the editor is showing. Draft mode resets the draft;
  // saved-note mode resets the editor buffer (debounced auto-save flushes
  // the empty content to disk so the clear sticks).
  clearCurrent(): void {
    const id = this.activeProjectId;
    if (!id) return;
    if (this.view === null) {
      this.writeActiveDraft('');
      void this.cleanupImages(id);
    } else {
      this.savedContentByProject = { ...this.savedContentByProject, [id]: '' };
      const status = this.statusByProject[id];
      if (status === 'saved' || status === 'error') {
        this.statusByProject = { ...this.statusByProject, [id]: 'idle' };
        this.errorMessageByProject = { ...this.errorMessageByProject, [id]: null };
      }
    }
  }

  updateSavedContent(content: string): void {
    const id = this.activeProjectId;
    if (!id) return;
    this.savedContentByProject = { ...this.savedContentByProject, [id]: content };
    const status = this.statusByProject[id];
    if (status === 'saved' || status === 'error') {
      this.statusByProject = { ...this.statusByProject, [id]: 'idle' };
      this.errorMessageByProject = { ...this.errorMessageByProject, [id]: null };
    }
  }

  async selectNote(filename: string): Promise<void> {
    const id = this.activeProjectId;
    if (!id) return;
    this.viewByProject = { ...this.viewByProject, [id]: filename };
    this.statusByProject = { ...this.statusByProject, [id]: 'idle' };
    this.errorMessageByProject = { ...this.errorMessageByProject, [id]: null };
    this.rememberSelection(filename);
    try {
      const note = await ipc.notes.read(id, filename);
      this.savedContentByProject = { ...this.savedContentByProject, [id]: note.content };
      this.savedDiskByProject = { ...this.savedDiskByProject, [id]: note.content };
    } catch (err) {
      this.statusByProject = { ...this.statusByProject, [id]: 'error' };
      this.errorMessageByProject = {
        ...this.errorMessageByProject,
        [id]: err instanceof Error ? err.message : String(err)
      };
    }
  }

  async saveDraft(filename: string): Promise<void> {
    const id = this.activeProjectId;
    if (!id) return;
    const content = this.readActiveDraft();
    this.statusByProject = { ...this.statusByProject, [id]: 'saving' };
    try {
      const note = await ipc.notes.write(id, filename, content);
      this.clearActiveDraft();
      this.viewByProject = { ...this.viewByProject, [id]: note.filename };
      this.savedContentByProject = { ...this.savedContentByProject, [id]: note.content };
      this.savedDiskByProject = { ...this.savedDiskByProject, [id]: note.content };
      this.statusByProject = { ...this.statusByProject, [id]: 'saved' };
      this.errorMessageByProject = { ...this.errorMessageByProject, [id]: null };
      this.rememberSelection(note.filename);
      await this.refresh(id);
    } catch (err) {
      this.statusByProject = { ...this.statusByProject, [id]: 'error' };
      this.errorMessageByProject = {
        ...this.errorMessageByProject,
        [id]: err instanceof Error ? err.message : String(err)
      };
      throw err;
    }
  }

  async flushSaved(): Promise<void> {
    const id = this.activeProjectId;
    if (!id) return;
    const filename = this.viewByProject[id];
    if (!filename) return;
    const content = this.savedContentByProject[id] ?? '';
    if (content === (this.savedDiskByProject[id] ?? '')) return;
    this.statusByProject = { ...this.statusByProject, [id]: 'saving' };
    try {
      const note = await ipc.notes.write(id, filename, content);
      this.savedDiskByProject = { ...this.savedDiskByProject, [id]: note.content };
      // Only mark saved if the current buffer matches what we wrote — otherwise more typing happened
      if ((this.savedContentByProject[id] ?? '') === note.content) {
        this.statusByProject = { ...this.statusByProject, [id]: 'saved' };
      } else {
        this.statusByProject = { ...this.statusByProject, [id]: 'idle' };
      }
      this.errorMessageByProject = { ...this.errorMessageByProject, [id]: null };
    } catch (err) {
      this.statusByProject = { ...this.statusByProject, [id]: 'error' };
      this.errorMessageByProject = {
        ...this.errorMessageByProject,
        [id]: err instanceof Error ? err.message : String(err)
      };
    }
  }

  async rename(oldName: string, newName: string): Promise<void> {
    const id = this.activeProjectId;
    if (!id) return;
    const summary = await ipc.notes.rename(id, oldName, newName);
    if (this.viewByProject[id] === oldName) {
      this.viewByProject = { ...this.viewByProject, [id]: summary.filename };
    }
    this.renameWorktreeMemoryFor(id, oldName, summary.filename);
  }

  async remove(filename: string): Promise<void> {
    const id = this.activeProjectId;
    if (!id) return;
    await ipc.notes.delete(id, filename);
    if (this.viewByProject[id] === filename) {
      this.viewByProject = { ...this.viewByProject, [id]: null };
      this.savedContentByProject = { ...this.savedContentByProject, [id]: '' };
      this.savedDiskByProject = { ...this.savedDiskByProject, [id]: '' };
    }
    this.dropWorktreeMemoryFor(id, (name) => name === filename);
    await this.cleanupImages(id);
  }

  // Brings the editor back to whatever saved note this worktree had open the
  // last time it was active. Called by RailNotesTab when the active worktree
  // (or project) changes. No-op if the worktree never had a selection — that
  // worktree just stays in draft mode.
  async restoreForActiveWorktree(): Promise<void> {
    const id = this.activeProjectId;
    const cwd = this.activeWorktreeCwd;
    if (!id || !cwd) return;
    const entry = this.viewByWorktree[cwd];
    const desired: string | null =
      entry && entry.projectId === id ? entry.filename : null;
    const currentView = this.viewByProject[id] ?? null;
    if (currentView === desired) return;
    // Flush any pending edits on the previous selection so its dirty buffer
    // doesn't vanish when we swap to the new note.
    await this.flushSaved().catch(() => {});
    if (desired === null) {
      this.viewByProject = { ...this.viewByProject, [id]: null };
      this.savedContentByProject = { ...this.savedContentByProject, [id]: '' };
      this.savedDiskByProject = { ...this.savedDiskByProject, [id]: '' };
      this.statusByProject = { ...this.statusByProject, [id]: 'idle' };
      this.errorMessageByProject = { ...this.errorMessageByProject, [id]: null };
      return;
    }
    await this.ensureLoaded(id).catch(() => {});
    const list = this.listsByProject[id] ?? [];
    if (!list.some((n) => n.filename === desired)) {
      this.dropWorktreeMemoryFor(id, (name) => name === desired);
      this.viewByProject = { ...this.viewByProject, [id]: null };
      this.savedContentByProject = { ...this.savedContentByProject, [id]: '' };
      this.savedDiskByProject = { ...this.savedDiskByProject, [id]: '' };
      return;
    }
    await this.selectNote(desired);
  }

  private rememberSelection(filename: string | null): void {
    const cwd = this.activeWorktreeCwd;
    const id = this.activeProjectId;
    if (!cwd || !id) return;
    const next = { ...this.viewByWorktree };
    if (filename) {
      next[cwd] = { projectId: id, filename };
      persistViewSelection(cwd, next[cwd]);
    } else {
      delete next[cwd];
      persistViewSelection(cwd, null);
    }
    this.viewByWorktree = next;
  }

  private dropWorktreeMemoryFor(
    projectId: ProjectId,
    matches: (filename: string) => boolean
  ): void {
    let changed = false;
    const next = { ...this.viewByWorktree };
    for (const [cwd, entry] of Object.entries(next)) {
      if (entry.projectId !== projectId) continue;
      if (!matches(entry.filename)) continue;
      delete next[cwd];
      persistViewSelection(cwd, null);
      changed = true;
    }
    if (changed) this.viewByWorktree = next;
  }

  private renameWorktreeMemoryFor(
    projectId: ProjectId,
    oldName: string,
    newName: string
  ): void {
    let changed = false;
    const next = { ...this.viewByWorktree };
    for (const [cwd, entry] of Object.entries(next)) {
      if (entry.projectId !== projectId) continue;
      if (entry.filename !== oldName) continue;
      next[cwd] = { projectId, filename: newName };
      persistViewSelection(cwd, next[cwd]);
      changed = true;
    }
    if (changed) this.viewByWorktree = next;
  }

  async pasteImages(payloads: NoteImagePayload[]): Promise<NoteImage[]> {
    const id = this.activeProjectId;
    if (!id) return [];
    const saved: NoteImage[] = [];
    for (const p of payloads) {
      const image = await ipc.notes.saveImage(id, p.mimeType, p.dataBase64);
      saved.push(image);
    }
    return saved;
  }

  // Sweep unreferenced images for the current project (or a specified one).
  // The backend reads saved-note bodies on its own; we hand it the in-memory
  // drafts so still-unsaved references aren't treated as orphans. In
  // per-worktree mode, every worktree's draft for this project contributes.
  async cleanupImages(projectId?: ProjectId): Promise<void> {
    const id = projectId ?? this.activeProjectId;
    if (!id) return;
    const extras: string[] = [];
    const projectDraft = this.draftsByProject[id];
    if (projectDraft && projectDraft.length > 0) extras.push(projectDraft);
    const prefix = `${id}::`;
    for (const [key, content] of Object.entries(this.draftsByWorktree)) {
      if (!key.startsWith(prefix)) continue;
      if (content && content.length > 0) extras.push(content);
    }
    try {
      await ipc.notes.cleanupImages(id, extras);
    } catch {
      // best-effort — leaving an orphan is harmless
    }
  }

  private get draftsPerWorktreeEnabled(): boolean {
    return settings.current.notes?.draftsPerWorktree === true;
  }

  private activeDraftLocation():
    | { kind: 'project'; projectId: ProjectId }
    | { kind: 'worktree'; projectId: ProjectId; storageKey: string }
    | null {
    const id = this.activeProjectId;
    if (!id) return null;
    if (this.draftsPerWorktreeEnabled) {
      const cwd = this.activeWorktreeCwd;
      if (cwd) return { kind: 'worktree', projectId: id, storageKey: worktreeDraftStorageKey(id, cwd) };
    }
    return { kind: 'project', projectId: id };
  }

  private readActiveDraft(): string {
    const loc = this.activeDraftLocation();
    if (!loc) return '';
    if (loc.kind === 'worktree') return this.draftsByWorktree[loc.storageKey] ?? '';
    return this.draftsByProject[loc.projectId] ?? '';
  }

  private hasActiveDraft(): boolean {
    const loc = this.activeDraftLocation();
    if (!loc) return false;
    if (loc.kind === 'worktree') return this.draftsByWorktree[loc.storageKey] !== undefined;
    return this.draftsByProject[loc.projectId] !== undefined;
  }

  private writeActiveDraft(content: string): void {
    const loc = this.activeDraftLocation();
    if (!loc) return;
    if (loc.kind === 'worktree') {
      this.draftsByWorktree = { ...this.draftsByWorktree, [loc.storageKey]: content };
      persistWorktreeDraft(loc.storageKey, content);
    } else {
      this.draftsByProject = { ...this.draftsByProject, [loc.projectId]: content };
      persistProjectDraft(loc.projectId, content);
    }
  }

  private clearActiveDraft(): void {
    const loc = this.activeDraftLocation();
    if (!loc) return;
    if (loc.kind === 'worktree') {
      const next = { ...this.draftsByWorktree };
      delete next[loc.storageKey];
      this.draftsByWorktree = next;
      clearStoredWorktreeDraft(loc.storageKey);
    } else {
      const next = { ...this.draftsByProject };
      delete next[loc.projectId];
      this.draftsByProject = next;
      clearStoredProjectDraft(loc.projectId);
    }
  }
}

export const notes = new NotesStoreClass();
