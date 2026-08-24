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

describe('narrow pane toolbars', () => {
  it('keeps shared pane headers on one horizontally scrollable row', () => {
    expect(css).toMatch(
      /\.soloe-pane-header\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/s
    );
  });

  it('scrolls the Browser controls horizontally instead of wrapping them', () => {
    expect(css).toMatch(
      /\.mobile-browser-toolbar\s*\{[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/s
    );
  });

  it('keeps terminal branch and action controls available on narrow screens', () => {
    expect(css).not.toMatch(
      /\.session-toolbar-branch,\s*\.session-toolbar-actions\s*>\s*:not\(:last-child\)\s*\{[^}]*display:\s*none/s
    );
  });
});
