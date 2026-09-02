import type { GhosttySnapshot } from './core';

export interface TerminalPredictedCell {
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

export interface TerminalPredictionOverlay {
  readonly cells: readonly TerminalPredictedCell[];
  readonly cursor: { readonly x: number; readonly y: number } | null;
}

interface PendingCellPrediction extends TerminalPredictedCell {
  readonly kind: 'cell';
  readonly baseline: string;
}

interface PendingLineBreakPrediction {
  readonly kind: 'line-break';
  readonly x: number;
  readonly y: number;
}

type PendingPrediction = PendingCellPrediction | PendingLineBreakPrediction;

const EMPTY_OVERLAY: TerminalPredictionOverlay = { cells: [], cursor: null };

/**
 * Optimistic local echo for remote terminals. Safe printable text is painted
 * at the authoritative cursor until remote output confirms or contradicts it.
 * Controls clear the pending sequence because their screen effect is unknown.
 */
export class TerminalPredictionModel {
  private pending: PendingPrediction[] = [];

  type(text: string, snapshot: GhosttySnapshot): boolean {
    if (!isSafeSingleCellText(text)) {
      this.boundary();
      return false;
    }
    const position = this.nextPosition(snapshot);
    if (!position) {
      this.boundary();
      return false;
    }
    const baseline = snapshot.rowData[position.y]?.cells[position.x]?.text ?? '';
    if (baseline.length > 0) {
      this.boundary();
      return false;
    }
    this.pending.push({ kind: 'cell', ...position, text, baseline });
    return true;
  }

  lineBreak(snapshot: GhosttySnapshot): boolean {
    const position = this.nextPosition(snapshot);
    const firstCell = this.pending.find(
      (prediction): prediction is PendingCellPrediction => prediction.kind === 'cell'
    );
    const x = firstCell?.x ?? snapshot.cursorX;
    const y = (position?.y ?? -1) + 1;
    if (!position || x < 0 || x >= snapshot.cols || y >= snapshot.rows) {
      this.boundary();
      return false;
    }
    this.pending.push({ kind: 'line-break', x, y });
    return true;
  }

  backspace(): boolean {
    return this.pending.pop() !== undefined;
  }

  boundary(): void {
    this.pending = [];
  }

  reconcile(snapshot: GhosttySnapshot): void {
    if (this.pending.length === 0) return;
    let lastConfirmedIndex = -1;
    for (const [index, prediction] of this.pending.entries()) {
      if (prediction.kind === 'line-break') {
        if (snapshot.cursorY >= prediction.y) lastConfirmedIndex = index;
        continue;
      }
      const current = snapshot.rowData[prediction.y]?.cells[prediction.x]?.text ?? '';
      if (current === prediction.text && prediction.baseline !== prediction.text) {
        lastConfirmedIndex = index;
        continue;
      }
      if (current === prediction.baseline) continue;
      this.boundary();
      return;
    }
    if (lastConfirmedIndex >= 0) {
      this.pending = this.pending.slice(lastConfirmedIndex + 1);
    }
  }

  overlay(snapshot: GhosttySnapshot): TerminalPredictionOverlay {
    if (this.pending.length === 0) return EMPTY_OVERLAY;
    const cells: TerminalPredictedCell[] = [];
    for (const prediction of this.pending) {
      if (prediction.kind === 'line-break') continue;
      const current = snapshot.rowData[prediction.y]?.cells[prediction.x]?.text ?? '';
      if (current !== prediction.baseline) continue;
      cells.push({ x: prediction.x, y: prediction.y, text: prediction.text });
    }
    const cursor = this.nextPosition(snapshot);
    if (cells.length === 0 && cursor === null) return EMPTY_OVERLAY;
    return {
      cells,
      cursor
    };
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  private nextPosition(
    snapshot: GhosttySnapshot
  ): { readonly x: number; readonly y: number } | null {
    const last = this.pending.at(-1);
    if (!last) {
      if (
        snapshot.cursorX < 0
        || snapshot.cursorY < 0
        || snapshot.cursorX >= snapshot.cols
        || snapshot.cursorY >= snapshot.rows
      ) {
        return null;
      }
      return { x: snapshot.cursorX, y: snapshot.cursorY };
    }
    if (last.kind === 'line-break') return { x: last.x, y: last.y };
    return advance(last.x, last.y, snapshot.cols, snapshot.rows);
  }
}

function isSafeSingleCellText(text: string): boolean {
  return text.length === 1 && text >= ' ' && text <= '~';
}

function advance(
  x: number,
  y: number,
  cols: number,
  rows: number
): { readonly x: number; readonly y: number } | null {
  if (x + 1 < cols) return { x: x + 1, y };
  if (y + 1 < rows) return { x: 0, y: y + 1 };
  return null;
}
