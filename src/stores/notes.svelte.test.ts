/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteSummary } from '@shared/types/notes.js';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  list: vi.fn<(_projectId: string) => Promise<NoteSummary[]>>(async () => []),
  noteChanges: {
    emit: (_event: { projectId: string; notes: NoteSummary[] }): void => {}
  },
  reconnects: {
    emit: (): void => {}
  },
  selected: {
    id: 'session',
    projectId: 'project',
    cwd: '/home/me/repo',
    runMode: 'wsl' as const,
    wslDistro: 'Ubuntu'
  }
}));

vi.mock('../lib/ipc', () => ({
  ipc: {
    notes: {
      read: mocks.read,
      write: mocks.write,
      list: mocks.list,
      rename: vi.fn(),
      delete: vi.fn(),
      saveImage: vi.fn(),
      cleanupImages: vi.fn(),
      onChange: vi.fn((callback: (event: {
        projectId: string;
        notes: NoteSummary[];
      }) => void) => {
        mocks.noteChanges.emit = callback;
        return () => undefined;
      })
    },
    connection: {
      onReconnect: vi.fn((callback: () => void) => {
        mocks.reconnects.emit = callback;
        return () => undefined;
      })
    }
  }
}));

vi.mock('./sessions.svelte', () => ({
  sessions: { selected: mocks.selected }
}));

vi.mock('./settings.svelte', () => ({
  settings: { current: { notes: { draftsPerWorktree: true } } }
}));

import { NotesDraftPersistence } from '../lib/notes-draft-persistence';
import { NotesStore, notesWorktreeStorageKey } from './notes.svelte';

beforeEach(() => {
  localStorage.clear();
  mocks.read.mockReset();
  mocks.write.mockReset();
  mocks.list.mockClear();
});

describe('NotesStore durability', () => {
  it('isolates equal WSL paths by distribution', () => {
    const ubuntu = notesWorktreeStorageKey('project', {
      cwd: '/home/me/repo',
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    });
    const debian = notesWorktreeStorageKey('project', {
      cwd: '/home/me/repo',
      runMode: 'wsl',
      wslDistro: 'Debian'
    });

    expect(ubuntu).not.toBe(debian);
  });

  it('blocks note replacement when the current saved buffer cannot flush', async () => {
    const store = createStore();
    mocks.read.mockResolvedValue(note('a.md', 'disk A'));
    await store.selectNote('a.md');
    store.updateSavedContent('edited A');
    mocks.write.mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(store.selectNote('b.md')).rejects.toThrow('disk unavailable');

    expect(store.selectedFilename).toBe('a.md');
    expect(store.savedContent).toBe('edited A');
    expect(store.savedDirty).toBe(true);
  });

  it('waits for the real in-flight flush before replacing the editor buffer', async () => {
    const store = createStore();
    mocks.read.mockImplementation(async (_projectId: string, filename: string) =>
      note(filename, filename === 'a.md' ? 'disk A' : 'disk B')
    );
    await store.selectNote('a.md');
    store.updateSavedContent('edited A');
    const pendingWrite = deferred<ReturnType<typeof note>>();
    mocks.write.mockReturnValueOnce(pendingWrite.promise);

    const switching = store.selectNote('b.md');
    await Promise.resolve();
    expect(store.selectedFilename).toBe('a.md');

    pendingWrite.resolve(note('a.md', 'edited A'));
    await switching;

    expect(store.selectedFilename).toBe('b.md');
    expect(store.savedContent).toBe('disk B');
  });

  it('ignores a stale read that resolves after a newer selection', async () => {
    const store = createStore();
    const reads = {
      b: deferred<ReturnType<typeof note>>(),
      c: deferred<ReturnType<typeof note>>()
    };
    mocks.read.mockImplementation((_projectId: string, filename: string) =>
      filename === 'b.md' ? reads.b.promise : reads.c.promise
    );

    const selectingB = store.selectNote('b.md');
    const selectingC = store.selectNote('c.md');
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledWith('project', 'c.md'));
    reads.c.resolve(note('c.md', 'content C'));
    await selectingC;
    reads.b.resolve(note('b.md', 'content B'));
    await selectingB;

    expect(store.selectedFilename).toBe('c.md');
    expect(store.savedContent).toBe('content C');
  });

  it('does not clear newer draft text typed while a save is in flight', async () => {
    const store = createStore();
    store.updateDraftContent('save this snapshot');
    const pendingWrite = deferred<ReturnType<typeof note>>();
    mocks.write.mockReturnValueOnce(pendingWrite.promise);

    const saving = store.saveDraft('saved.md');
    store.updateDraftContent('newer draft text');
    pendingWrite.resolve(note('saved.md', 'save this snapshot'));
    await saving;

    expect(store.isDraft).toBe(true);
    expect(store.draftContent).toBe('newer draft text');
  });

  it('recovers a dirty saved buffer after synchronous shutdown persistence', async () => {
    const first = createStore();
    mocks.read.mockResolvedValue(note('note.md', 'disk content'));
    await first.selectNote('note.md');
    first.updateSavedContent('recovered edit');
    first.flushDraftPersistence();

    const restarted = createStore();
    await restarted.selectNote('note.md');

    expect(restarted.savedContent).toBe('recovered edit');
    expect(restarted.savedDirty).toBe(true);
  });

  it('refreshes loaded projects after reconnect without replacing a newer event', async () => {
    const store = createStore();
    mocks.list.mockResolvedValueOnce([summary('initial.md')]);
    await store.ensureLoaded('project');
    store.attachListeners();
    const pending = deferred<Array<ReturnType<typeof summary>>>();
    mocks.list.mockReturnValueOnce(pending.promise);

    mocks.reconnects.emit();
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    mocks.noteChanges.emit({
      projectId: 'project',
      notes: [summary('newer.md')]
    });
    pending.resolve([summary('stale.md')]);
    await pending.promise;
    await Promise.resolve();

    expect(store.listsByProject.project).toEqual([summary('newer.md')]);
    store.detach();
  });
});

function createStore(): NotesStore {
  return new NotesStore(new NotesDraftPersistence(localStorage, 10_000));
}

function note(filename: string, content: string) {
  return { filename, content, updatedAt: 1 };
}

function summary(filename: string) {
  return { filename, size: 1, updatedAt: 1 };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
