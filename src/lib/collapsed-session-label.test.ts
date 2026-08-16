import { describe, expect, it } from 'vitest';

import { collapsedSessionTabLabel } from './collapsed-session-label.js';

describe('collapsedSessionTabLabel', () => {
  it('keeps the owning Device visible beside the Session name', () => {
    expect(collapsedSessionTabLabel('Review API', 'xps')).toBe('Review API · xps');
  });
});
