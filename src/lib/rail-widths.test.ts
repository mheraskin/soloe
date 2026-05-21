import { describe, expect, it } from 'vitest';
import { withScenarioWidths, type ScenarioWidths } from './rail-widths';

describe('withScenarioWidths', () => {
  const widths: ScenarioWidths = { A: 300, B: 500, C0: 220, C1: 220 };

  it('keeps the same object when a two-pane clamp has already settled', () => {
    expect(withScenarioWidths('C', widths, 220, 220)).toBe(widths);
  });

  it('updates the active scenario when the requested widths change', () => {
    expect(withScenarioWidths('C', widths, 260, 220)).toEqual({
      A: 300,
      B: 500,
      C0: 260,
      C1: 220
    });
  });
});
