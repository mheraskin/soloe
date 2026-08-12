// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nativeSurfaceBounds,
  setRendererZoom,
  subscribeNativeSurfaceBlocker
} from './native-surface-layout';

describe('native surface layout', () => {
  afterEach(() => {
    setRendererZoom(1);
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('maps zoomed CSS coordinates back to Tauri logical coordinates', () => {
    setRendererZoom(1.4);

    expect(nativeSurfaceBounds(new DOMRect(12, 24, 640, 360))).toEqual({
      x: 16.8,
      y: 33.6,
      width: 896,
      height: 504
    });
  });

  it('blocks native children while a portal or rail drag must sit above them', async () => {
    const states: boolean[] = [];
    const unsubscribe = subscribeNativeSurfaceBlocker((blocked) => states.push(blocked));

    const dialog = document.createElement('div');
    dialog.dataset.slot = 'dialog-content';
    document.body.append(dialog);
    await Promise.resolve();

    dialog.remove();
    await Promise.resolve();
    window.dispatchEvent(new CustomEvent('soloe:rail-resize-start'));
    window.dispatchEvent(new CustomEvent('soloe:rail-resize-end'));

    expect(states).toEqual([false, true, false, true, false]);
    unsubscribe();
  });
});
