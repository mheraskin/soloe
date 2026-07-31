// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { changePageZoom } from './page-zoom';

describe('changePageZoom', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('zoom');
  });

  it('zooms the web application locally without a backend RPC', () => {
    expect(changePageZoom('in')).toBe(1.1);
    expect(document.documentElement.style.zoom).toBe('1.1');

    expect(changePageZoom('out')).toBe(1);
    expect(document.documentElement.style.zoom).toBe('');
  });

  it('supports resetting and clamps repeated zoom changes', () => {
    for (let index = 0; index < 20; index += 1) changePageZoom('in');
    expect(document.documentElement.style.zoom).toBe('2');

    expect(changePageZoom('reset')).toBe(1);
    expect(document.documentElement.style.zoom).toBe('');
  });
});
