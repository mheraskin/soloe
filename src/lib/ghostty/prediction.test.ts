import { describe, expect, it } from 'vitest';

import type { GhosttyCell, GhosttySnapshot } from './core';
import { TerminalPredictionModel } from './prediction';

describe('TerminalPredictionModel', () => {
  it('shows safe input immediately without waiting for a remote echo', () => {
    const model = new TerminalPredictionModel();
    const initial = snapshot('', 0);

    expect(model.type('h', initial)).toBe(true);
    expect(model.overlay(initial)).toEqual({
      cells: [{ x: 0, y: 0, text: 'h' }],
      cursor: { x: 1, y: 0 }
    });
  });

  it('removes only the last unconfirmed character on backspace', () => {
    const model = new TerminalPredictionModel();
    const initial = snapshot('', 0);
    model.type('a', initial);
    model.type('b', initial);
    model.type('c', initial);

    expect(model.backspace()).toBe(true);
    expect(model.overlay(initial)).toEqual({
      cells: [
        { x: 0, y: 0, text: 'a' },
        { x: 1, y: 0, text: 'b' }
      ],
      cursor: { x: 2, y: 0 }
    });
  });

  it('continues prediction on the next input row after Shift+Enter', () => {
    const model = new TerminalPredictionModel();
    const initial = snapshot('', 2, 8, 3);
    model.type('a', initial);
    model.type('b', initial);

    expect(model.lineBreak(initial)).toBe(true);
    expect(model.type('c', initial)).toBe(true);
    expect(model.overlay(initial)).toEqual({
      cells: [
        { x: 2, y: 0, text: 'a' },
        { x: 3, y: 0, text: 'b' },
        { x: 2, y: 1, text: 'c' }
      ],
      cursor: { x: 3, y: 1 }
    });

    expect(model.backspace()).toBe(true);
    expect(model.backspace()).toBe(true);
    expect(model.overlay(initial)).toEqual({
      cells: [
        { x: 2, y: 0, text: 'a' },
        { x: 3, y: 0, text: 'b' }
      ],
      cursor: { x: 4, y: 0 }
    });
  });

  it('reconciles immediate predictions as the remote echo catches up', () => {
    const model = new TerminalPredictionModel();
    const initial = snapshot('', 0);

    expect(model.type('h', initial)).toBe(true);
    expect(model.overlay(initial)).toEqual({
      cells: [{ x: 0, y: 0, text: 'h' }],
      cursor: { x: 1, y: 0 }
    });

    const confirmed = snapshot('h', 1);
    model.reconcile(confirmed);
    expect(model.type('i', confirmed)).toBe(true);
    expect(model.overlay(confirmed)).toEqual({
      cells: [{ x: 1, y: 0, text: 'i' }],
      cursor: { x: 2, y: 0 }
    });

    model.reconcile(snapshot('hi', 2));
    expect(model.overlay(snapshot('hi', 2))).toEqual({ cells: [], cursor: null });
  });

  it('starts from the authoritative cursor after controls and row changes', () => {
    const model = new TerminalPredictionModel();
    model.type('a', snapshot('', 0));
    model.reconcile(snapshot('a', 1));

    model.boundary();
    const next = snapshot('a', 1);
    model.type('b', next);
    expect(model.overlay(next)).toEqual({
      cells: [{ x: 1, y: 0, text: 'b' }],
      cursor: { x: 2, y: 0 }
    });

    model.reconcile(snapshot('ab', 2));
    const nextRow = snapshot('', 0, 4, 2, 1);
    model.type('c', nextRow);
    expect(model.overlay(nextRow)).toEqual({
      cells: [{ x: 0, y: 1, text: 'c' }],
      cursor: { x: 1, y: 1 }
    });
  });

  it('drops an epoch when the authoritative screen contradicts it', () => {
    const model = new TerminalPredictionModel();
    const initial = snapshot('', 0);
    model.type('a', initial);
    model.reconcile(snapshot('a', 1));
    model.type('b', snapshot('a', 1));
    expect(model.overlay(snapshot('a', 1)).cells).toHaveLength(1);

    model.reconcile(snapshot('ax', 2));
    expect(model.overlay(snapshot('ax', 2))).toEqual({ cells: [], cursor: null });
  });

  it('retires a predicted space when a later glyph proves the ordered echo', () => {
    const model = new TerminalPredictionModel();
    const initial = snapshot('', 0);
    model.type('a', initial);
    model.reconcile(snapshot('a', 1));

    const confirmed = snapshot('a', 1);
    model.type(' ', confirmed);
    model.type('m', confirmed);
    expect(model.overlay(confirmed)).toEqual({
      cells: [
        { x: 1, y: 0, text: ' ' },
        { x: 2, y: 0, text: 'm' }
      ],
      cursor: { x: 3, y: 0 }
    });

    const echoed = snapshot('a m', 3);
    model.reconcile(echoed);

    expect(model.overlay(echoed)).toEqual({ cells: [], cursor: null });
  });

  it('only predicts safe single-cell printable text into empty cells', () => {
    const model = new TerminalPredictionModel();

    expect(model.type('é', snapshot('', 0))).toBe(false);
    expect(model.type('?', snapshot('x', 0))).toBe(false);
    expect(model.type('*', snapshot('', 0))).toBe(true);
  });
});

function snapshot(
  text: string,
  cursorX: number,
  cols = 8,
  rows = 1,
  cursorY = 0
): GhosttySnapshot {
  const cells = Array.from({ length: cols }, (_, index) => {
    const value = text[index] ?? '';
    return cell(value === ' ' ? '' : value);
  });
  return {
    cols,
    rows,
    foreground: { r: 220, g: 220, b: 220 },
    background: { r: 20, g: 20, b: 20 },
    cursor: { r: 220, g: 220, b: 220 },
    cursorX,
    cursorY,
    cursorVisible: true,
    cursorBlinking: false,
    cursorStyle: 0,
    dirtyRows: new Set([cursorY]),
    rowData: Array.from({ length: rows }, (_, row) => ({
      cells: row === cursorY ? cells : Array.from({ length: cols }, () => cell('')),
      text: row === cursorY ? text.padEnd(cols) : ''.padEnd(cols),
      isWrapContinuation: false,
      wrapsToNext: false
    }))
  };
}

function cell(text: string): GhosttyCell {
  return {
    text,
    foreground: { r: 220, g: 220, b: 220 },
    background: { r: 20, g: 20, b: 20 },
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    overline: false,
    invisible: false,
    selected: false,
    wide: 0
  };
}
