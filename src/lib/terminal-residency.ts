export interface TerminalResidencyIntent {
  liveSessionIds: readonly string[];
  visibleSessionIds: readonly string[];
}

/**
 * Keeps terminal presentation residency bounded independently of PTY lifetime.
 * Visible Sessions are always resident; recently visible live Sessions fill
 * the remaining LRU slots.
 */
export class TerminalResidency {
  private recent: string[] = [];

  constructor(private readonly maxResidents = 4) {}

  reconcile(intent: TerminalResidencyIntent): string[] {
    const live = new Set(intent.liveSessionIds);
    const visible = unique(intent.visibleSessionIds).filter((id) => live.has(id));
    const visibleSet = new Set(visible);
    const limit = Math.max(visible.length, positiveInteger(this.maxResidents, 4));
    this.recent = [
      ...visible,
      ...this.recent.filter((id) => live.has(id) && !visibleSet.has(id))
    ].slice(0, limit);
    return [...this.recent];
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
