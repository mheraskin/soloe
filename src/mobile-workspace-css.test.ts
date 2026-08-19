/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

describe('mobile workspace terminal clearance', () => {
  it('keeps terminal surfaces above the dock until the keyboard hides it', () => {
    expect(css).toMatch(
      /\.mobile-workspace-surface\s*\{[^}]*bottom:\s*var\(--mobile-workspace-dock-height\)/s
    );
    expect(css).toMatch(
      /html\[data-mobile-keyboard-open\]\s+\.mobile-workspace-surface\s*\{[^}]*bottom:\s*0/s
    );
  });
});
