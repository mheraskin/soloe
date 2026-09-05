import type { TerminalId } from '@shared/types/terminal.js';

export type TerminalPresentationKey = string;

export interface TerminalResidencyIntent {
  livePresentationKeys: readonly TerminalPresentationKey[];
  presentedKeys: readonly TerminalPresentationKey[];
  maxResidents: number;
}

export function localTerminalPresentationKey(terminalId: TerminalId): TerminalPresentationKey {
  return `local:${terminalId}`;
}

/**
 * Keeps terminal presentation residency bounded independently of PTY lifetime.
 * Presented Sessions are always resident; recently presented live Sessions
 * fill the remaining slots in most-recent-first order.
 */
export class TerminalResidency {
  private recent: TerminalPresentationKey[] = [];

  reconcile(intent: TerminalResidencyIntent): TerminalPresentationKey[] {
    const live = new Set(intent.livePresentationKeys);
    const presented = unique(intent.presentedKeys).filter((key) => live.has(key));
    const presentedSet = new Set(presented);
    const limit = positiveInteger(intent.maxResidents, 3);
    this.recent = [
      ...presented,
      ...this.recent.filter((key) => live.has(key) && !presentedSet.has(key))
    ].slice(0, limit);
    return [...this.recent];
  }
}

function unique(values: readonly TerminalPresentationKey[]): TerminalPresentationKey[] {
  return [...new Set(values.filter(Boolean))];
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
