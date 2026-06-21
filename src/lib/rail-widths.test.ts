import { describe, expect, it } from 'vitest';
import { clampRailWidth, clampSplitRatio, splitPaneWidths } from './rail-widths';

describe('clampSplitRatio', () => {
  it('clamps below the minimum', () => expect(clampSplitRatio(0.05)).toBe(0.2));
  it('clamps above the maximum', () => expect(clampSplitRatio(0.95)).toBe(0.8));
  it('passes a valid ratio through', () => expect(clampSplitRatio(0.5)).toBe(0.5));
  it('falls back to 0.5 for non-finite input', () => expect(clampSplitRatio(Number.NaN)).toBe(0.5));
});

describe('clampRailWidth', () => {
  it('clamps to the min', () => expect(clampRailWidth(50, 220, 800)).toBe(220));
  it('clamps to the max', () => expect(clampRailWidth(1200, 220, 800)).toBe(800));
  it('rounds a value within range', () => expect(clampRailWidth(443.6, 220, 800)).toBe(444));
});

describe('splitPaneWidths', () => {
  it('splits evenly at ratio 0.5', () => {
    expect(splitPaneWidths(804, 0.5, 220, 4)).toEqual([400, 400]);
  });
  it('honors the per-pane minimum on the left', () => {
    expect(splitPaneWidths(604, 0.1, 220, 4)).toEqual([220, 380]);
  });
  it('honors the per-pane minimum on the right', () => {
    expect(splitPaneWidths(604, 0.9, 220, 4)).toEqual([380, 220]);
  });
});
