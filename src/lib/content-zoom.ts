export const CONTENT_ZOOM_FACTORS = [
  0.25,
  0.33,
  0.5,
  0.67,
  0.75,
  0.8,
  0.9,
  1,
  1.1,
  1.25,
  1.5,
  1.75,
  2,
  2.5,
  3,
  4,
  5
] as const;

export type ContentZoomDirection = 'in' | 'out' | 'reset';

export function isContentZoomDirection(value: unknown): value is ContentZoomDirection {
  return value === 'in' || value === 'out' || value === 'reset';
}

export function nextContentZoomFactor(
  current: number,
  direction: ContentZoomDirection
): number {
  if (direction === 'reset') return 1;
  const tolerance = 0.001;
  if (direction === 'in') {
    for (const factor of CONTENT_ZOOM_FACTORS) {
      if (factor > current + tolerance) return factor;
    }
    return CONTENT_ZOOM_FACTORS[CONTENT_ZOOM_FACTORS.length - 1]!;
  }
  for (let index = CONTENT_ZOOM_FACTORS.length - 1; index >= 0; index -= 1) {
    const factor = CONTENT_ZOOM_FACTORS[index]!;
    if (factor < current - tolerance) return factor;
  }
  return CONTENT_ZOOM_FACTORS[0]!;
}
