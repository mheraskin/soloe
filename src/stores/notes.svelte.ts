import type { ProjectId } from '@shared/types/projects.js';
import type { NoteImage, NoteImagePayload, NoteSummary } from '@shared/types/notes.js';
import {
  worktreeScope,
  worktreeScopeKey,
  type WorktreeScope
} from '@shared/worktree-identity.js';
import { ipc } from '../lib/ipc';
import { sessions } from './sessions.svelte';
import { settings } from './settings.svelte';
import {
  NotesDraftPersistence,
  savedNoteRecoveryKey,
  type NotesDraftAddress
} from '../lib/notes-draft-persistence';

export type NotesStatus = 'idle' | 'saving' | 'saved' | 'error';

export function notesWorktreeStorageKey(
  projectId: ProjectId,
  scope: WorktreeScope
): string {
  return `${projectId}::${worktreeScopeKey(scope)}`;
}

// Per-worktree memory of which saved note was last open. Notes live at the
// project level (shared across worktrees) but each worktree should restore the
// selection it had before the user navigated away. The key is an exact
// Worktree Identity, not a path: equal Linux paths in different WSL distros
// must never share editor state.
const VIEW_KEY_PREFIX = 'soloe.notes.viewByWorktree.v2.';
const LEGACY_VIEW_KEY_PREFIX = 'soloe.notes.viewByWorktree.';
const SAVED_NOTE_DEBOUNCE_MS = 500;

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
  identityKey: string,
  entry: WorktreeViewEntry | null
): void {
  if (typeof localStorage === 'undefined') return;
  const key = VIEW_KEY_PREFIX + identityKey;
  try {
    if (entry) localStorage.setItem(key, JSON.stringify(entry));
    else localStorage.removeItem(key);
  } catch {
    // Quota / private mode — best effort.
  }
}

function loadLegacyView(scope: WorktreeScope): WorktreeViewEntry | null {
  // A path-only WSL entry is ambiguous and must never be guessed into a
  // distro. Native Windows entries can be migrated without changing identity.
  if (scope.runMode !== 'windows' || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LEGACY_VIEW_KEY_PREFIX + scope.cwd);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed
      || typeof parsed !== 'object'
      || typeof (parsed as { projectId?: unknown }).projectId !== 'string'
      || typeof (parsed as { filename?: unknown }).filename !== 'string'
    ) return null;
    return parsed as WorktreeViewEntry;
  } catch {
    return null;
  }
}

type DraftLocation =
  | { kind: 'project'; projectId: ProjectId }
  | { kind: 'worktree'; projectId: ProjectId; storageKey: string };

export class NotesStore {
  listsByProject = $state<Record<ProjectId, NoteSummary[]>>({});
  loadedProjects = $state<Record<ProjectId, boolean>>({});

  draftsByProject = $state<Record<ProjectId, string>>({});

  // Drafts persisted per exact (Project, Worktree Identity) when settings.notes
  // .draftsPerWorktree is on.
  draftsByWorktree = $state<Record<string, string>>({});

  // Restart-safe recovery for saved-note editor buffers that are newer than
  // the authoritative file. Key = savedNoteRecoveryKey(projectId, filename).
  savedRecoveryByNote = $state<Record<string, string>>({});

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
  activeWorktreeScope = $derived.by<WorktreeScope | null>(() => {
    const selected = sessions.selected;
    if (!selected) return null;
    return worktreeScope(selected.cwd, {
      runMode: selected.runMode,
      ...(selected.wslDistro ? { wslDistro: selected.wslDistro } : {})
    });
  });
  activeWorktreeKey = $derived<string | null>(
    this.activeWorktreeScope ? worktreeScopeKey(this.activeWorktreeScope) : null
  );

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
  private savedFlushTimers = new Map<ProjectId, ReturnType<typeof setTimeout>>();
  private savedFlushRequests = new Map<ProjectId, Promise<void>>();
  private selectionGeneration = new Map<ProjectId, number>();

  constructor(
    private readonly draftPersistence: NotesDraftPersistence = new NotesDraftPersistence()
  ) {
    const loaded = draftPersistence.load();
    this.draftsByProject = loaded.byProject;
    this.draftsByWorktree = loaded.byWorktree;
    this.savedRecoveryByNote = loaded.bySaved;
  }

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
          this.invalidateSelection(event.projectId);
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
    for (const timer of this.savedFlushTimers.values()) clearTimeout(timer);
    this.savedFlushTimers.clear();
    this.draftPersistence.flushAll();
  }

  flushDraftPersistence(): void {
    this.draftPersistence.flushAll();
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

  async newDraft(): Promise<void> {
    const id = this.activeProjectId;
    if (!id) return;
    const generation = this.nextSelectionGeneration(id);
    if (this.viewByProject[id]) await this.flushSaved(id);
    if (this.selectionGeneration.get(id) !== generation) return;
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
      this.updateSavedContent('');
    }
  }

  updateSavedContent(content: string): void {
    const id = this.activeProjectId;
    const filename = id ? this.viewByProject[id] : null;
    if (!id || !filename) return;
    this.savedContentByProject = { ...this.savedContentByProject, [id]: content };
    const recoveryKey = savedNoteRecoveryKey(id, filename);
    this.savedRecoveryByNote = { ...this.savedRecoveryByNote, [recoveryKey]: content };
    this.draftPersistence.schedule({ kind: 'saved', projectId: id, filename }, content);
    const status = this.statusByProject[id];
    if (status === 'saved' || status === 'error') {
      this.statusByProject = { ...this.statusByProject, [id]: 'idle' };
      this.errorMessageByProject = { ...this.errorMessageByProject, [id]: null };
    }
    this.scheduleSavedFlush(id);
  }

  async selectNote(filename: string): Promise<void> {
    const id = this.activeProjectId;
    if (!id) return;
    const generation = this.nextSelectionGeneration(id);
    const currentFilename = this.viewByProject[id];
    if (currentFilename && currentFilename !== filename) {
      // Navigation is destructive to the sole saved-note editor buffer. Wait
      // for the actual write and leave the old note visible if it fails.
      await this.flushSaved(id);
    }
    if (this.selectionGeneration.get(id) !== generation) return;
    this.viewByProject = { ...this.viewByProject, [id]: filename };
    this.statusByProject = { ...this.statusByProject, [id]: 'idle' };
    this.errorMessageByProject = { ...this.errorMessageByProject, [id]: null };
    this.rememberSelection(filename);
    try {
      const note = await ipc.notes.read(id, filename);
      if (!this.isCurrentSelection(id, filename, generation)) return;
      const recovery = this.savedRecoveryByNote[savedNoteRecoveryKey(id, filename)];
      const content = recovery ?? note.content;
      this.savedContentByProject = { ...this.savedContentByProject, [id]: content };
      this.savedDiskByProject = { ...this.savedDiskByProject, [id]: note.content };
      if (recovery !== undefined && recovery !== note.content) this.scheduleSavedFlush(id);
    } catch (err) {
      if (!this.isCurrentSelection(id, filename, generation)) return;
      this.statusByProject = { ...this.statusByProject, [id]: 'error' };
      this.errorMessageByProject = {
        ...this.errorMessageByProject,
        [id]: err instanceof Error ? err.message : String(err)
      };
    }
  }

  async saveDraft(filename: string): Promise<void> {
    const id = this.activeProjectId;
    const draftLocation = this.activeDraftLocation();
    const identityKey = this.activeWorktreeKey;
    if (!id || !draftLocation) return;
    const generation = this.nextSelectionGeneration(id);
    const content = this.readDraftAt(draftLocation);
    this.statusByProject = { ...this.statusByProject, [id]: 'saving' };
    try {
      const note = await ipc.notes.write(id, filename, content);
      const draftUnchanged = this.readDraftAt(draftLocation) === content;
      if (draftUnchanged) this.clearDraftAt(draftLocation);
      await this.refresh(id);
      if (draftUnchanged && identityKey) {
        this.rememberSelectionFor(identityKey, id, note.filename);
      }
      if (
        !draftUnchanged
        || this.selectionGeneration.get(id) !== generation
        || !identityKey
        || !this.isActiveWorktree(id, identityKey)
      ) {
        this.statusByProject = { ...this.statusByProject, [id]: 'idle' };
        return;
      }
      this.viewByProject = { ...this.viewByProject, [id]: note.filename };
      this.savedContentByProject = { ...this.savedContentByProject, [id]: note.content };
      this.savedDiskByProject = { ...this.savedDiskByProject, [id]: note.content };
      this.statusByProject = { ...this.statusByProject, [id]: 'saved' };
      this.errorMessageByProject = { ...this.errorMessageByProject, [id]: null };
    } catch (err) {
      this.statusByProject = { ...this.statusByProject, [id]: 'error' };
      this.errorMessageByProject = {
        ...this.errorMessageByProject,
        [id]: err instanceof Error ? err.message : String(err)
      };
      throw err;
    }
  }

  async flushSaved(projectId?: ProjectId): Promise<void> {
    const id = projectId ?? this.activeProjectId;
    if (!id) return;
    this.clearSavedFlushTimer(id);
    const existing = this.savedFlushRequests.get(id);
    if (existing) return existing;

    let request!: Promise<void>;
    request = (async () => {
      do {
        await this.flushSavedOnce(id);
      } while (
        this.viewByProject[id]
          && (this.savedContentByProject[id] ?? '') !== (this.savedDiskByProject[id] ?? '')
      );
    })().finally(() => {
      if (this.savedFlushRequests.get(id) === request) this.savedFlushRequests.delete(id);
    });
    this.savedFlushRequests.set(id, request);
    return request;
  }

  private scheduleSavedFlush(projectId: ProjectId): void {
    this.clearSavedFlushTimer(projectId);
    const timer = setTimeout(() => {
      this.savedFlushTimers.delete(projectId);
      void this.flushSaved(projectId).catch(() => {});
    }, SAVED_NOTE_DEBOUNCE_MS);
    this.savedFlushTimers.set(projectId, timer);
  }

  private clearSavedFlushTimer(projectId: ProjectId): void {
    const timer = this.savedFlushTimers.get(projectId);
    if (!timer) return;
    clearTimeout(timer);
    this.savedFlushTimers.delete(projectId);
  }

  private async flushSavedOnce(projectId: ProjectId): Promise<void> {
    const filename = this.viewByProject[projectId];
    if (!filename) return;
    const content = this.savedContentByProject[projectId] ?? '';
    if (content === (this.savedDiskByProject[projectId] ?? '')) return;
    this.statusByProject = { ...this.statusByProject, [projectId]: 'saving' };
    try {
      const note = await ipc.notes.write(projectId, filename, content);
      this.savedDiskByProject = { ...this.savedDiskByProject, [projectId]: note.content };
      // Only mark saved if the current buffer matches what we wrote; otherwise
      // the outer flush loop will immediately write the newer text.
      if (
        this.viewByProject[projectId] === filename
        && (this.savedContentByProject[projectId] ?? '') === note.content
      ) {
        this.statusByProject = { ...this.statusByProject, [projectId]: 'saved' };
        this.removeSavedRecovery(projectId, filename);
      } else {
        this.statusByProject = { ...this.statusByProject, [projectId]: 'idle' };
      }
      this.errorMessageByProject = { ...this.errorMessageByProject, [projectId]: null };
    } catch (err) {
      this.statusByProject = { ...this.statusByProject, [projectId]: 'error' };
      this.errorMessageByProject = {
        ...this.errorMessageByProject,
        [projectId]: err instanceof Error ? err.message : String(err)
      };
      throw err;
    }
  }

  async rename(oldName: string, newName: string): Promise<void> {
    const id = this.activeProjectId;
    if (!id) return;
    if (this.viewByProject[id] === oldName) await this.flushSaved(id);
    const summary = await ipc.notes.rename(id, oldName, newName);
    if (this.viewByProject[id] === oldName) {
      this.invalidateSelection(id);
      this.viewByProject = { ...this.viewByProject, [id]: summary.filename };
    }
    this.renameWorktreeMemoryFor(id, oldName, summary.filename);
  }

  async remove(filename: string): Promise<void> {
    const id = this.activeProjectId;
    if (!id) return;
    if (this.viewByProject[id] === filename) await this.flushSaved(id);
    await ipc.notes.delete(id, filename);
    this.removeSavedRecovery(id, filename);
    if (this.viewByProject[id] === filename) {
      this.invalidateSelection(id);
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
    const scope = this.activeWorktreeScope;
    if (!id || !scope) return;
    const identityKey = worktreeScopeKey(scope);
    this.migrateLegacyDraft(id, scope);
    let entry = this.viewByWorktree[identityKey];
    if (!entry) {
      const legacy = loadLegacyView(scope);
      if (legacy?.projectId === id) {
        entry = legacy;
        this.rememberSelectionFor(identityKey, id, legacy.filename);
      }
    }
    const desired: string | null =
      entry && entry.projectId === id ? entry.filename : null;
    const currentView = this.viewByProject[id] ?? null;
    if (currentView === desired) return;
    const generation = this.nextSelectionGeneration(id);
    // Flush any pending edits on the previous selection so its dirty buffer
    // doesn't vanish when we swap to the new note.
    await this.flushSaved(id);
    if (
      !this.isActiveWorktree(id, identityKey)
      || this.selectionGeneration.get(id) !== generation
    ) return;
    if (desired === null) {
      this.viewByProject = { ...this.viewByProject, [id]: null };
      this.savedContentByProject = { ...this.savedContentByProject, [id]: '' };
      this.savedDiskByProject = { ...this.savedDiskByProject, [id]: '' };
      this.statusByProject = { ...this.statusByProject, [id]: 'idle' };
      this.errorMessageByProject = { ...this.errorMessageByProject, [id]: null };
      return;
    }
    await this.ensureLoaded(id);
    if (
      !this.isActiveWorktree(id, identityKey)
      || this.selectionGeneration.get(id) !== generation
    ) return;
    const list = this.listsByProject[id] ?? [];
    if (!list.some((n) => n.filename === desired)) {
      this.dropWorktreeMemoryFor(id, (name) => name === desired);
      this.invalidateSelection(id);
      this.viewByProject = { ...this.viewByProject, [id]: null };
      this.savedContentByProject = { ...this.savedContentByProject, [id]: '' };
      this.savedDiskByProject = { ...this.savedDiskByProject, [id]: '' };
      return;
    }
    await this.selectNote(desired);
  }

  private rememberSelection(filename: string | null): void {
    const identityKey = this.activeWorktreeKey;
    const id = this.activeProjectId;
    if (!identityKey || !id) return;
    this.rememberSelectionFor(identityKey, id, filename);
  }

  private rememberSelectionFor(
    identityKey: string,
    projectId: ProjectId,
    filename: string | null
  ): void {
    const next = { ...this.viewByWorktree };
    if (filename) {
      next[identityKey] = { projectId, filename };
      persistViewSelection(identityKey, next[identityKey]);
    } else {
      delete next[identityKey];
      persistViewSelection(identityKey, null);
    }
    this.viewByWorktree = next;
  }

  private dropWorktreeMemoryFor(
    projectId: ProjectId,
    matches: (filename: string) => boolean
  ): void {
    let changed = false;
    const next = { ...this.viewByWorktree };
    for (const [identityKey, entry] of Object.entries(next)) {
      if (entry.projectId !== projectId) continue;
      if (!matches(entry.filename)) continue;
      delete next[identityKey];
      persistViewSelection(identityKey, null);
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
    for (const [identityKey, entry] of Object.entries(next)) {
      if (entry.projectId !== projectId) continue;
      if (entry.filename !== oldName) continue;
      next[identityKey] = { projectId, filename: newName };
      persistViewSelection(identityKey, next[identityKey]);
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

  private activeDraftLocation(): DraftLocation | null {
    const id = this.activeProjectId;
    if (!id) return null;
    if (this.draftsPerWorktreeEnabled) {
      const scope = this.activeWorktreeScope;
      if (scope) {
        return {
          kind: 'worktree',
          projectId: id,
          storageKey: notesWorktreeStorageKey(id, scope)
        };
      }
    }
    return { kind: 'project', projectId: id };
  }

  private readActiveDraft(): string {
    const loc = this.activeDraftLocation();
    if (!loc) return '';
    return this.readDraftAt(loc);
  }

  private readDraftAt(loc: DraftLocation): string {
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
      const address: NotesDraftAddress = {
        kind: 'worktree',
        projectId: loc.projectId,
        storageKey: loc.storageKey
      };
      this.draftPersistence.schedule(address, content);
    } else {
      this.draftsByProject = { ...this.draftsByProject, [loc.projectId]: content };
      this.draftPersistence.schedule({ kind: 'project', projectId: loc.projectId }, content);
    }
  }

  private clearActiveDraft(): void {
    const loc = this.activeDraftLocation();
    if (!loc) return;
    this.clearDraftAt(loc);
  }

  private clearDraftAt(loc: DraftLocation): void {
    if (loc.kind === 'worktree') {
      const next = { ...this.draftsByWorktree };
      delete next[loc.storageKey];
      this.draftsByWorktree = next;
      this.draftPersistence.remove({
        kind: 'worktree',
        projectId: loc.projectId,
        storageKey: loc.storageKey
      });
    } else {
      const next = { ...this.draftsByProject };
      delete next[loc.projectId];
      this.draftsByProject = next;
      this.draftPersistence.remove({ kind: 'project', projectId: loc.projectId });
    }
  }

  private removeSavedRecovery(projectId: ProjectId, filename: string): void {
    const key = savedNoteRecoveryKey(projectId, filename);
    if (Object.prototype.hasOwnProperty.call(this.savedRecoveryByNote, key)) {
      const next = { ...this.savedRecoveryByNote };
      delete next[key];
      this.savedRecoveryByNote = next;
    }
    this.draftPersistence.remove({ kind: 'saved', projectId, filename });
  }

  private migrateLegacyDraft(projectId: ProjectId, scope: WorktreeScope): void {
    if (scope.runMode !== 'windows') return;
    const storageKey = notesWorktreeStorageKey(projectId, scope);
    if (this.draftsByWorktree[storageKey] !== undefined) return;
    const legacyStorageKey = `${projectId}::${scope.cwd}`;
    const content = this.draftsByWorktree[legacyStorageKey];
    if (content === undefined) return;
    const next = { ...this.draftsByWorktree, [storageKey]: content };
    delete next[legacyStorageKey];
    this.draftsByWorktree = next;
    this.draftPersistence.remove({
      kind: 'worktree',
      projectId,
      storageKey: legacyStorageKey
    });
    this.draftPersistence.schedule({ kind: 'worktree', projectId, storageKey }, content);
  }

  private nextSelectionGeneration(projectId: ProjectId): number {
    const generation = (this.selectionGeneration.get(projectId) ?? 0) + 1;
    this.selectionGeneration.set(projectId, generation);
    return generation;
  }

  private invalidateSelection(projectId: ProjectId): void {
    this.nextSelectionGeneration(projectId);
  }

  private isCurrentSelection(
    projectId: ProjectId,
    filename: string,
    generation: number
  ): boolean {
    return this.viewByProject[projectId] === filename
      && this.selectionGeneration.get(projectId) === generation;
  }

  private isActiveWorktree(projectId: ProjectId, identityKey: string): boolean {
    return this.activeProjectId === projectId && this.activeWorktreeKey === identityKey;
  }
}

export const notes = new NotesStore();
