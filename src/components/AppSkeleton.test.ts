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

  it('reserves native macOS traffic lights without drawing right-side window controls', () => {
    const { body } = render(AppSkeleton, {
      props: { macosWindowControls: true }
    });

    expect(body).toContain('data-window-controls="macos"');
    expect(body).toContain('ml-[76px]');
    expect(body).not.toContain('data-loading-region="window-controls"');
  });
});
