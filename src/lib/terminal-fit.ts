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
  private redrawFrame: number | null = null;
  private scheduledFitFrame: number | null = null;
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
    this.cancelRedraw();
    const generation = this.generation;
    this.redrawFrame = this.requestFrame(() => {
      this.redrawFrame = null;
      if (generation !== this.generation || !canRedraw() || terminal.rows <= 0) return;
      terminal.refresh(0, terminal.rows - 1);
    });
    return { cols: terminal.cols, rows: terminal.rows };
  }

  scheduleFit(
    terminal: TerminalFitTarget,
    fitAddon: FitAddonTarget,
    canFit: () => boolean = () => true,
    onFit: (size: { cols: number; rows: number }) => void = () => {},
    onError: (error: unknown) => void = () => {}
  ): void {
    if (this.scheduledFitFrame !== null) return;
    this.cancelRedraw();
    const generation = this.generation;
    this.scheduledFitFrame = this.requestFrame(() => {
      this.scheduledFitFrame = null;
      if (generation !== this.generation || !canFit()) return;
      try {
        onFit(this.fit(terminal, fitAddon, canFit));
      } catch (error) {
        onError(error);
      }
    });
  }

  cancel(): void {
    this.generation += 1;
    if (this.scheduledFitFrame !== null) {
      this.cancelFrame(this.scheduledFitFrame);
      this.scheduledFitFrame = null;
    }
    if (this.redrawFrame !== null) {
      this.cancelFrame(this.redrawFrame);
      this.redrawFrame = null;
    }
  }

  private cancelRedraw(): void {
    this.generation += 1;
    if (this.redrawFrame === null) return;
    this.cancelFrame(this.redrawFrame);
    this.redrawFrame = null;
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
