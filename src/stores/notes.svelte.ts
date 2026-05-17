import type { ProjectId } from '@shared/types/projects.js';
import type { NoteImage, NoteImagePayload, NoteSummary } from '@shared/types/notes.js';
import { ipc } from '../lib/ipc';
import { sessions } from './sessions.svelte';

export type NotesStatus = 'idle' | 'saving' | 'saved' | 'error';

// Per-project draft persistence. Drafts are scratch space — they survive app
// restarts in localStorage so a half-written note isn't lost just because the
// user closed the window before saving to disk. The key prefix is namespaced
// so projects can't collide. Removed on save/discard.
const DRAFT_KEY_PREFIX = 'soloe.notes.draft.';

function loadDraftsFromStorage(): Record<ProjectId, string> {
  if (typeof localStorage === 'undefined') return {};
  const result: Record<ProjectId, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(DRAFT_KEY_PREFIX)) continue;
      const value = localStorage.getItem(key);
      if (value !== null && value.length > 0) {
        const projectId = key.slice(DRAFT_KEY_PREFIX.length) as ProjectId;
        result[projectId] = value;
      }
    }
  } catch {
    // Storage disabled (private mode / quota). Drafts stay in-memory only.
  }
  return result;
}

function persistDraft(projectId: ProjectId, content: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (content.length > 0) {
      localStorage.setItem(DRAFT_KEY_PREFIX + projectId, content);
    } else {
      localStorage.removeItem(DRAFT_KEY_PREFIX + projectId);
    }
  } catch {
    // Quota / private mode — silently fall back to in-memory only.
  }
}

function clearStoredDraft(projectId: ProjectId): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(DRAFT_KEY_PREFIX + projectId);
  } catch {
    // No-op.
  }
}

class NotesStoreClass {
  listsByProject = $state<Record<ProjectId, NoteSummary[]>>({});
  loadedProjects = $state<Record<ProjectId, boolean>>({});

  draftsByProject = $state<Record<ProjectId, string>>(loadDraftsFromStorage());

  // null view = draft is showing, string = saved-note filename
  viewByProject = $state<Record<ProjectId, string | null>>({});

  savedContentByProject = $state<Record<ProjectId, string>>({});
  savedDiskByProject = $state<Record<ProjectId, string>>({});

  statusByProject = $state<Record<ProjectId, NotesStatus>>({});
  errorMessageByProject = $state<Record<ProjectId, string | null>>({});

  activeProjectId = $derived<ProjectId | null>(sessions.selected?.projectId ?? null);

  notes = $derived<NoteSummary[]>(
    this.activeProjectId ? this.listsByProject[this.activeProjectId] ?? [] : []
  );

  view = $derived<string | null>(
    this.activeProjectId ? this.viewByProject[this.activeProjectId] ?? null : null
  );

  isDraft = $derived<boolean>(this.activeProjectId !== null && this.view === null);

  selectedFilename = $derived<string | null>(this.view);

  draftContent = $derived<string>(
    this.activeProjectId ? this.draftsByProject[this.activeProjectId] ?? '' : ''
  );

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
        const activeFilename = this.viewByProject[event.projectId];
        if (activeFilename && !event.notes.some((n) => n.filename === activeFilename)) {
          // selected note was deleted/renamed externally; revert to draft
          this.viewByProject = { ...this.viewByProject, [event.projectId]: null };
          this.savedContentByProject = { ...this.savedContentByProject, [event.projectId]: '' };
          this.savedDiskByProject = { ...this.savedDiskByProject, [event.projectId]: '' };
        }
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
    if (this.draftsByProject[id] === undefined) {
      this.draftsByProject = { ...this.draftsByProject, [id]: '' };
    }
  }

  discardDraft(): void {
    const id = this.activeProjectId;
    if (!id) return;
    const next = { ...this.draftsByProject };
    delete next[id];
    this.draftsByProject = next;
    clearStoredDraft(id);
    void this.cleanupImages(id);
  }

  updateDraftContent(content: string): void {
    const id = this.activeProjectId;
    if (!id) return;
    this.draftsByProject = { ...this.draftsByProject, [id]: content };
    persistDraft(id, content);
  }

  // Wipes whatever the editor is showing. Draft mode resets the draft;
  // saved-note mode resets the editor buffer (debounced auto-save flushes
  // the empty content to disk so the clear sticks).
  clearCurrent(): void {
    const id = this.activeProjectId;
    if (!id) return;
    if (this.view === null) {
      this.draftsByProject = { ...this.draftsByProject, [id]: '' };
      clearStoredDraft(id);
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
    const content = this.draftsByProject[id] ?? '';
    this.statusByProject = { ...this.statusByProject, [id]: 'saving' };
    try {
      const note = await ipc.notes.write(id, filename, content);
      const drafts = { ...this.draftsByProject };
      delete drafts[id];
      this.draftsByProject = drafts;
      clearStoredDraft(id);
      this.viewByProject = { ...this.viewByProject, [id]: note.filename };
      this.savedContentByProject = { ...this.savedContentByProject, [id]: note.content };
      this.savedDiskByProject = { ...this.savedDiskByProject, [id]: note.content };
      this.statusByProject = { ...this.statusByProject, [id]: 'saved' };
      this.errorMessageByProject = { ...this.errorMessageByProject, [id]: null };
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
    await this.cleanupImages(id);
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
  // draft so still-unsaved references aren't treated as orphans.
  async cleanupImages(projectId?: ProjectId): Promise<void> {
    const id = projectId ?? this.activeProjectId;
    if (!id) return;
    const draft = this.draftsByProject[id];
    const extras: string[] = [];
    if (draft && draft.length > 0) extras.push(draft);
    try {
      await ipc.notes.cleanupImages(id, extras);
    } catch {
      // best-effort — leaving an orphan is harmless
    }
  }
}

export const notes = new NotesStoreClass();
