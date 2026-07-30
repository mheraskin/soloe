import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import AppSkeleton from './AppSkeleton.svelte';

describe('AppSkeleton', () => {
  it('renders an accessible full-application loading shell', () => {
    const { body } = render(AppSkeleton);

    expect(body).toContain('role="status"');
    expect(body).toContain('aria-busy="true"');
    expect(body).toContain('Loading Soloe');
    expect(body).toContain('data-loading-region="sidebar"');
    expect(body).toContain('data-loading-region="terminal"');
    expect(body).toContain('data-loading-region="rail"');
  });
});
