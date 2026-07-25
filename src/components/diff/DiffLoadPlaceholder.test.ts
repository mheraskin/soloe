import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import DiffLoadPlaceholder from './DiffLoadPlaceholder.svelte';

describe('DiffLoadPlaceholder', () => {
  it('offers an explicit load action for an unloaded diff', () => {
    const onLoad = vi.fn();
    const { body } = render(DiffLoadPlaceholder, {
      props: { loading: false, error: null, onLoad }
    });

    expect(body).toContain('Diff not loaded');
    expect(body).toContain('<button');
    expect(body).toContain('Load diff');
  });

  it('offers retry after a diff load error', () => {
    const onLoad = vi.fn();
    const { body } = render(DiffLoadPlaceholder, {
      props: { loading: false, error: 'Git failed', onLoad }
    });

    expect(body).toContain('Git failed');
    expect(body).toContain('<button');
    expect(body).toContain('Retry');
  });
});
