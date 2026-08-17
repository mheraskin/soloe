import { SerializeAddon } from '@xterm/addon-serialize';
import headlessXterm from '@xterm/headless';
import type { RuntimeTerminalScreenSnapshot } from '@soloe/protocol';

const { Terminal } = headlessXterm;

interface HeadlessTerminal {
  write(data: string, callback: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

interface TerminalScreenAdapter {
  terminal: HeadlessTerminal;
  serialize(options: { scrollback: number }): string;
}

interface ScreenState {
  terminalId: string;
  sessionId: string;
  cols: number;
  rows: number;
  toSeq: number;
  adapter: TerminalScreenAdapter;
  queue: Promise<void>;
}

export interface TerminalScreenStateOptions {
  createTerminal?: (input: { cols: number; rows: number }) => TerminalScreenAdapter;
}

export class TerminalScreenState {
  private readonly screens = new Map<string, ScreenState>();
  private readonly createTerminal: NonNullable<TerminalScreenStateOptions['createTerminal']>;

  constructor(options: TerminalScreenStateOptions = {}) {
    this.createTerminal = options.createTerminal ?? createHeadlessTerminal;
  }

  register(input: {
    terminalId: string;
    sessionId: string;
    cols: number;
    rows: number;
  }): void {
    const existing = this.screens.get(input.terminalId);
    if (existing?.sessionId === input.sessionId) return;
    existing?.adapter.terminal.dispose();
    this.screens.set(input.terminalId, {
      ...input,
      toSeq: 0,
      adapter: this.createTerminal({ cols: input.cols, rows: input.rows }),
      queue: Promise.resolve()
    });
  }

  write(terminalId: string, seq: number, data: string): Promise<void> {
    const screen = this.require(terminalId);
    if (!Number.isSafeInteger(seq)) return screen.queue;
    return this.enqueue(screen, () => {
      if (seq <= screen.toSeq) return;
      return new Promise<void>((resolve) => {
        screen.adapter.terminal.write(data, () => {
          screen.toSeq = seq;
          resolve();
        });
      });
    });
  }

  resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const screen = this.require(terminalId);
    return this.enqueue(screen, () => {
      screen.adapter.terminal.resize(cols, rows);
      screen.cols = cols;
      screen.rows = rows;
    });
  }

  async snapshot(terminalId: string): Promise<RuntimeTerminalScreenSnapshot> {
    const screen = this.require(terminalId);
    await screen.queue;
    return {
      kind: 'xterm-vt-state-v1',
      terminalId: screen.terminalId,
      sessionId: screen.sessionId,
      cols: screen.cols,
      rows: screen.rows,
      toSeq: screen.toSeq,
      data: screen.adapter.serialize({ scrollback: 0 })
    };
  }

  remove(terminalId: string): boolean {
    const screen = this.screens.get(terminalId);
    if (!screen) return false;
    this.screens.delete(terminalId);
    void screen.queue.finally(() => screen.adapter.terminal.dispose());
    return true;
  }

  clear(): void {
    for (const terminalId of [...this.screens.keys()]) this.remove(terminalId);
  }

  private require(terminalId: string): ScreenState {
    const screen = this.screens.get(terminalId);
    if (!screen) throw new Error(`Terminal screen not found: ${terminalId}`);
    return screen;
  }

  private enqueue(screen: ScreenState, operation: () => void | Promise<void>): Promise<void> {
    const next = screen.queue.then(operation);
    screen.queue = next.catch(() => undefined);
    return next;
  }
}

function createHeadlessTerminal(input: { cols: number; rows: number }): TerminalScreenAdapter {
  const terminal = new Terminal({
    cols: input.cols,
    rows: input.rows,
    scrollback: 1_000,
    allowProposedApi: true
  });
  const serialize = new SerializeAddon();
  terminal.loadAddon(serialize);
  return {
    terminal,
    serialize: (options) => serialize.serialize(options)
  };
}
