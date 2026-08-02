import { describe, expect, it } from 'vitest';
import {
  formatSourceLocation,
  mapGuestRectToHost,
  normalizeSourceFrame,
  normalizeSourcePath,
  placeInspectorViewer,
  shortcutSignature
} from './element-source-inspector';

describe('element source inspector helpers', () => {
  it('accepts project-relative paths and rejects traversal', () => {
    expect(normalizeSourcePath('./src/Button.svelte', '/workspace/app')).toBe('src/Button.svelte');
    expect(normalizeSourcePath('/workspace/app/src/Button.svelte', '/workspace/app'))
      .toBe('src/Button.svelte');
    expect(normalizeSourcePath('../outside.svelte', '/workspace/app')).toBeNull();
    expect(normalizeSourcePath('/workspace/other.svelte', '/workspace/app')).toBeNull();
  });

  it('maps Docker workspace paths into the selected host project', () => {
    expect(normalizeSourcePath(
      '/workspace/frontend/dashboard/src/routes/+page.svelte',
      '/home/user/projects/order-ahead'
    )).toBe('frontend/dashboard/src/routes/+page.svelte');
  });

  it('normalizes source locations without inventing missing positions', () => {
    const frame = normalizeSourceFrame({
      filePath: 'src/Button.svelte',
      lineNumber: 42.8,
      columnNumber: 0,
      componentName: '  Button  '
    }, '/workspace/app');
    expect(frame).toEqual({
      filePath: 'src/Button.svelte',
      lineNumber: 42,
      columnNumber: null,
      componentName: 'Button'
    });
    expect(formatSourceLocation(frame)).toBe('src/Button.svelte:42');
  });

  it('maps guest viewport coordinates through a scaled webview', () => {
    expect(mapGuestRectToHost({
      x: 20,
      y: 10,
      width: 100,
      height: 40,
      viewportWidth: 500,
      viewportHeight: 400
    }, { left: 100, top: 50, width: 1000, height: 800 })).toEqual({
      left: 140,
      top: 70,
      width: 200,
      height: 80
    });
  });

  it('keeps the viewer inside the browser panel', () => {
    const position = placeInspectorViewer(
      { left: 440, top: 160, width: 10, height: 20 },
      { left: 100, top: 100, right: 900, bottom: 700 }
    );
    expect(position.left + position.width).toBeLessThanOrEqual(892);
    expect(position.top + position.height).toBeLessThanOrEqual(692);
  });

  it('creates stable shortcut signatures for conflict checks', () => {
    expect(shortcutSignature(['Ctrl', 'Alt', 'Shift', 'S'])).toBe('ctrl+alt+shift+s');
  });
});
