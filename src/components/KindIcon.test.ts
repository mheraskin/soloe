import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import KindIcon from './KindIcon.svelte';

describe('KindIcon', () => {
  it.each([
    ['cursor', 'Cursor'],
    ['codex', 'Codex'],
    ['opencode', 'OpenCode'],
    ['grok_build', 'Grok Build']
  ] as const)('renders light and dark logo variants for %s', (kind, alt) => {
    const { body } = render(KindIcon, { props: { kind, size: 24 } });

    expect(body).toContain('theme-light');
    expect(body).toContain('theme-dark');
    expect(body.match(new RegExp(`alt="${alt}"`, 'g'))).toHaveLength(2);
    expect(body.match(/width="24"/g)).toHaveLength(2);
    expect(body.match(/height="24"/g)).toHaveLength(2);
  });

  it('keeps the Claude brand mark identical across themes', () => {
    const { body } = render(KindIcon, { props: { kind: 'claude_code' } });

    expect(body).toContain('alt="Claude"');
    expect(body).not.toContain('theme-light');
    expect(body).not.toContain('theme-dark');
  });
});
