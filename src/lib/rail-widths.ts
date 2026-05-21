export type ScenarioId = 'A' | 'B' | 'C';

export interface ScenarioWidths {
  A: number;
  B: number;
  C0: number;
  C1: number;
}

export function withScenarioWidths(
  currentScenario: ScenarioId,
  previous: ScenarioWidths,
  slot0: number,
  slot1: number
): ScenarioWidths {
  if (currentScenario === 'A') {
    return previous.A === slot0 ? previous : { ...previous, A: slot0 };
  }
  if (currentScenario === 'B') {
    return previous.B === slot0 ? previous : { ...previous, B: slot0 };
  }
  return previous.C0 === slot0 && previous.C1 === slot1
    ? previous
    : { ...previous, C0: slot0, C1: slot1 };
}
