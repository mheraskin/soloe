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
    expect(body).toContain('Commit selection is optional');
    expect(body).toContain('wherever that folder lives');
    expect(body).toContain('Comparison base');
    expect(body).toContain('parent immediately before the oldest selected commit');
    expect(body).toContain('Choose a branch to view its history');
    expect(body).not.toContain('Include working tree');
    expect(body).toContain('View branch');
  });
});
