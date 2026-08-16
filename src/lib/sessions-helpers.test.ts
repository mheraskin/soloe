import { describe, expect, it } from 'vitest';
import type { Session } from '@shared/types/sessions.js';
import { defaultDraft, kindLabel, toDraft, validateDraft } from './sessions-helpers';

describe('toDraft', () => {
  it('does not expose automatic rename provenance to the edit form', () => {
    const session: Session = {
      id: 'session-1',
      name: 'new codex',
      cwd: '/repo',
      runMode: 'linux',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-01-01T00:00:00.000Z',
      autoNamed: true
    };

    expect(toDraft(session)).not.toHaveProperty('autoNamed');
  });

  it('builds and labels a valid default Cursor draft', () => {
    const draft = defaultDraft('cursor');
    draft.name = 'Cursor';
    draft.cwd = '/repo';
    expect(kindLabel('cursor')).toBe('Cursor');
    expect(draft.launch).toEqual({
      type: 'agent', provider: 'cursor', resumeMode: 'new', cursorMode: 'agent'
    });
    expect(validateDraft(draft)).toBeNull();
  });

  it('requires a Cursor chat id only for exact resume', () => {
    const draft = defaultDraft('cursor');
    draft.name = 'Cursor';
    draft.cwd = '/repo';
    if (draft.launch.type === 'agent') draft.launch.resumeMode = 'resume_by_id';
    expect(validateDraft(draft)).toEqual({ field: 'cursorSessionId', message: 'Chat id required' });
  });
});
