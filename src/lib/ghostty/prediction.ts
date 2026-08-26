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

interface PendingPrediction extends TerminalPredictedCell {
  readonly baseline: string;
}

const EMPTY_OVERLAY: TerminalPredictionOverlay = { cells: [], cursor: null };

/**
 * Conservative Mosh-style prediction epochs. A row must first prove that the
 * remote application echoes printable text before later input on that row can
 * be drawn speculatively. Controls start a new epoch, which prevents password
 * prompts and non-echoing TUI commands from exposing speculative characters.
 */
export class TerminalPredictionModel {
  private pending: PendingPrediction[] = [];
  private confirmedRow: number | null = null;

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
    this.pending.push({ ...position, text, baseline });
    return true;
  }

  boundary(): void {
    this.pending = [];
    this.confirmedRow = null;
  }

  reconcile(snapshot: GhosttySnapshot): void {
    if (this.pending.length === 0) return;
    const remaining: PendingPrediction[] = [];
    for (const prediction of this.pending) {
      const current = snapshot.rowData[prediction.y]?.cells[prediction.x]?.text ?? '';
      if (current === prediction.text && prediction.baseline !== prediction.text) {
        this.confirmedRow = prediction.y;
        continue;
      }
      if (current === prediction.baseline) {
        remaining.push(prediction);
        continue;
      }
      this.boundary();
      return;
    }
    this.pending = remaining;
  }

  overlay(snapshot: GhosttySnapshot): TerminalPredictionOverlay {
    if (this.pending.length === 0 || this.confirmedRow === null) return EMPTY_OVERLAY;
    const cells: TerminalPredictedCell[] = [];
    for (const prediction of this.pending) {
      if (prediction.y !== this.confirmedRow) continue;
      const current = snapshot.rowData[prediction.y]?.cells[prediction.x]?.text ?? '';
      if (current !== prediction.baseline) continue;
      cells.push({ x: prediction.x, y: prediction.y, text: prediction.text });
    }
    if (cells.length === 0) return EMPTY_OVERLAY;
    const last = cells.at(-1)!;
    return {
      cells,
      cursor: advance(last.x, last.y, snapshot.cols, snapshot.rows)
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
