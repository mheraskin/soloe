/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NotesDraftPersistence,
  savedNoteRecoveryKey
} from './notes-draft-persistence';

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('NotesDraftPersistence', () => {
  it('coalesces a typing burst into one synchronous storage write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const persistence = new NotesDraftPersistence(localStorage, 250);
    const address = { kind: 'project' as const, projectId: 'project' };

    for (let index = 0; index < 1_000; index += 1) {
      persistence.schedule(address, `draft-${index}`);
    }
    expect(setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(setItem).toHaveBeenCalledOnce();
    expect(localStorage.getItem('soloe.notes.draft.project')).toBe('draft-999');
  });

  it('keeps Project and Worktree draft addresses independent', () => {
    const persistence = new NotesDraftPersistence(localStorage, 100);
    persistence.schedule({ kind: 'project', projectId: 'project' }, 'project draft');
    persistence.schedule({
      kind: 'worktree',
      projectId: 'project',
      storageKey: 'project::/repo'
    }, 'worktree draft');
    vi.advanceTimersByTime(100);

    expect(persistence.load()).toEqual({
      byProject: { project: 'project draft' },
      byWorktree: { 'project::/repo': 'worktree draft' },
      bySaved: {}
    });
  });

  it('coalesces and reloads saved-note recovery independently by filename', () => {
    const persistence = new NotesDraftPersistence(localStorage, 100);
    persistence.schedule(
      { kind: 'saved', projectId: 'project', filename: 'one.md' },
      'first edit'
    );
    persistence.schedule(
      { kind: 'saved', projectId: 'project', filename: 'one.md' },
      'latest edit'
    );
    persistence.schedule(
      { kind: 'saved', projectId: 'project', filename: 'two.md' },
      'other note'
    );
    vi.advanceTimersByTime(100);

    expect(persistence.load().bySaved).toEqual({
      [savedNoteRecoveryKey('project', 'one.md')]: 'latest edit',
      [savedNoteRecoveryKey('project', 'two.md')]: 'other note'
    });
  });

  it('preserves an intentionally emptied saved note for recovery', () => {
    const persistence = new NotesDraftPersistence(localStorage, 100);
    persistence.schedule(
      { kind: 'saved', projectId: 'project', filename: 'note.md' },
      ''
    );
    vi.advanceTimersByTime(100);

    expect(persistence.load().bySaved).toEqual({
      [savedNoteRecoveryKey('project', 'note.md')]: ''
    });
  });

  it('cannot resurrect a discarded draft from a pending timer', () => {
    const persistence = new NotesDraftPersistence(localStorage, 100);
    const address = { kind: 'project' as const, projectId: 'project' };
    persistence.schedule(address, 'pending');
    persistence.remove(address);
    vi.advanceTimersByTime(100);

    expect(localStorage.getItem('soloe.notes.draft.project')).toBeNull();
  });

  it('flushes every latest address synchronously for app shutdown', () => {
    const persistence = new NotesDraftPersistence(localStorage, 10_000);
    persistence.schedule({ kind: 'project', projectId: 'one' }, 'first');
    persistence.schedule({ kind: 'project', projectId: 'two' }, 'second');
    persistence.schedule(
      { kind: 'saved', projectId: 'one', filename: 'note.md' },
      'saved recovery'
    );

    persistence.flushAll();

    expect(localStorage.getItem('soloe.notes.draft.one')).toBe('first');
    expect(localStorage.getItem('soloe.notes.draft.two')).toBe('second');
    expect(persistence.load().bySaved).toEqual({
      [savedNoteRecoveryKey('one', 'note.md')]: 'saved recovery'
    });
  });
});
