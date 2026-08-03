import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { createReviewScope } from '../../stores/working-diff.svelte';
import CommitPicker from './CommitPicker.svelte';

describe('CommitPicker', () => {
  it('explains branch browsing, automatic comparison, and Worktree changes separately', () => {
    const { body } = render(CommitPicker, {
      props: {
        scope: createReviewScope('/repo'),
        onClose: vi.fn()
      }
    });

    expect(body).toContain('Browse branch history');
    expect(body).toContain('Browsing never changes the');
    expect(body).toContain('comparison base or target');
    expect(body).toContain('Comparison base');
    expect(body).toContain('parent immediately before the oldest selected commit');
    expect(body).toContain('Also show uncommitted changes');
    expect(body).not.toContain('Include working tree');
  });
});
