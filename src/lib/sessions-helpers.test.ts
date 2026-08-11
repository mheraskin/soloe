import { describe, expect, it } from 'vitest';
import type { Session } from '@shared/types/sessions.js';
import { toDraft } from './sessions-helpers';

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
});
