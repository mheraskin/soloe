/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  COCKPIT_PRESENTATION_ARCHIVE_KEY,
  migrateCockpitPresentationState
} from './cockpit-presentation-migration.js';

describe('migrateCockpitPresentationState', () => {
  beforeEach(() => localStorage.clear());

  it('archives presentation bytes additively and is restart-idempotent', () => {
    localStorage.setItem('soloe.notes.draft.compiler', 'not-json\u0000user text');
    localStorage.setItem('soloe.browser.v2', '{"tabs":[{"id":"one"}]}');
    localStorage.setItem('unrelated', 'leave me');

    const first = migrateCockpitPresentationState(localStorage, {
      catalogRevision: 4,
      deviceIds: ['11111111-1111-4111-8111-111111111111'],
      projectMap: { compiler: '22222222-2222-4222-8222-222222222222' },
      workspaceMap: { 'compiler:/repo': '33333333-3333-4333-8333-333333333333' },
      now: () => new Date('2026-08-12T12:00:00.000Z')
    });
    const second = migrateCockpitPresentationState(localStorage, {
      catalogRevision: 99,
      deviceIds: [],
      projectMap: {},
      workspaceMap: {}
    });

    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, archive: first.archive });
    expect(first.archive.entries).toEqual([
      { key: 'soloe.browser.v2', value: '{"tabs":[{"id":"one"}]}' },
      { key: 'soloe.notes.draft.compiler', value: 'not-json\u0000user text' }
    ]);
    expect(localStorage.getItem('soloe.notes.draft.compiler')).toBe('not-json\u0000user text');
    expect(localStorage.getItem('unrelated')).toBe('leave me');
    expect(JSON.parse(localStorage.getItem(COCKPIT_PRESENTATION_ARCHIVE_KEY)!)).toEqual(first.archive);
  });

  it('fails closed without touching legacy keys when the archive is too large', () => {
    localStorage.setItem('soloe.notes.draft.large', 'x'.repeat(128));

    expect(() => migrateCockpitPresentationState(localStorage, {
      catalogRevision: 0,
      deviceIds: [],
      projectMap: {},
      workspaceMap: {},
      maxBytes: 64
    })).toThrow('exceeds');
    expect(localStorage.getItem(COCKPIT_PRESENTATION_ARCHIVE_KEY)).toBeNull();
    expect(localStorage.getItem('soloe.notes.draft.large')).toBe('x'.repeat(128));
  });
});
