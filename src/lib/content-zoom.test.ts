import { describe, expect, it } from 'vitest';
import {
  isContentZoomDirection,
  nextContentZoomFactor
} from './content-zoom.js';

describe('content zoom', () => {
  it('uses the browser content zoom steps in both directions', () => {
    expect(nextContentZoomFactor(1, 'in')).toBe(1.1);
    expect(nextContentZoomFactor(1, 'out')).toBe(0.9);
    expect(nextContentZoomFactor(1.2, 'in')).toBe(1.25);
    expect(nextContentZoomFactor(1.2, 'out')).toBe(1.1);
  });

  it('resets and clamps at the browser limits', () => {
    expect(nextContentZoomFactor(4, 'reset')).toBe(1);
    expect(nextContentZoomFactor(5, 'in')).toBe(5);
    expect(nextContentZoomFactor(0.25, 'out')).toBe(0.25);
  });

  it('accepts only exact zoom directions', () => {
    expect(isContentZoomDirection('in')).toBe(true);
    expect(isContentZoomDirection('out')).toBe(true);
    expect(isContentZoomDirection('reset')).toBe(true);
    expect(isContentZoomDirection('+')).toBe(false);
  });
});
