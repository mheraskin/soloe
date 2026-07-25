export interface TerminalFitTarget {
  cols: number;
  rows: number;
  refresh(start: number, end: number): void;
}

export interface FitAddonTarget {
  fit(): void;
}

type RequestFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;

export class TerminalFitController {
  private frame: number | null = null;
  private generation = 0;

  constructor(
    private readonly requestFrame: RequestFrame = (callback) =>
      window.requestAnimationFrame(callback),
    private readonly cancelFrame: CancelFrame = (handle) =>
      window.cancelAnimationFrame(handle)
  ) {}

  fit(
    terminal: TerminalFitTarget,
    fitAddon: FitAddonTarget,
    canRedraw: () => boolean = () => true
  ): { cols: number; rows: number } {
    fitAddon.fit();
    this.cancel();
    const generation = this.generation;
    this.frame = this.requestFrame(() => {
      this.frame = null;
      if (generation !== this.generation || !canRedraw() || terminal.rows <= 0) return;
      terminal.refresh(0, terminal.rows - 1);
    });
    return { cols: terminal.cols, rows: terminal.rows };
  }

  cancel(): void {
    this.generation += 1;
    if (this.frame === null) return;
    this.cancelFrame(this.frame);
    this.frame = null;
  }
}

interface DisposableTerminal {
  dispose(): void;
}

export function deferTerminalDispose(
  terminal: DisposableTerminal,
  schedule: (callback: () => void) => void = (callback) => {
    window.setTimeout(callback, 0);
  }
): void {
  schedule(() => terminal.dispose());
}
