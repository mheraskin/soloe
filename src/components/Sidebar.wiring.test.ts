import { describe, expect, it } from 'vitest';
import source from './Sidebar.svelte?raw';

describe('Sidebar new-session launcher wiring', () => {
  it('opens below the top plus and extends to its right', () => {
    const launcher = source.match(/<AgentLaunchPopover[\s\S]*?\/>/)?.[0];

    expect(launcher).toBeDefined();
    expect(launcher).toContain('side="bottom"');
    expect(launcher).toContain('align="start"');
  });
});
