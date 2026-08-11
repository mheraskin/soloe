// Geometry for the right rail's two-pane split. The rail tracks a single
// content width plus a split ratio; per-pane widths and clamping derive from
// here so the drag handlers and the render path share one source of truth
// (replacing the old per-scenario A/B/C0/C1 memory model).

export const RAIL_SPLIT_MIN = 0.2;
export const RAIL_SPLIT_MAX = 0.8;

export interface RailSize {
  // Total rail content width in px (excludes the icon column). A single pane
  // fills it; two panes divide it by `splitRatio` minus the splitter gap.
  railWidth: number;
  // Fraction of the two-pane content area given to the left (slot 0) pane.
  splitRatio: number;
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(RAIL_SPLIT_MAX, Math.max(RAIL_SPLIT_MIN, ratio));
}

export function clampRailWidth(target: number, min: number, max: number): number {
  if (!Number.isFinite(target)) return min;
  return Math.max(min, Math.min(max, Math.round(target)));
}

// Split a total content width into [slot0, slot1], honoring the per-pane
// minimum and the splitter gap. The usable width floors at two minimums so a
// too-small total still yields valid (if oversized) panes; callers grow the
// total separately.
export function splitPaneWidths(
  total: number,
  ratio: number,
  minPane: number,
  splitter: number
): [number, number] {
  const usable = Math.max(minPane * 2, Math.round(total) - splitter);
  let slot0 = Math.round(usable * clampSplitRatio(ratio));
  slot0 = Math.max(minPane, Math.min(usable - minPane, slot0));
  return [slot0, usable - slot0];
}
