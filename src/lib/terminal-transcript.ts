import { Terminal, type IBufferCell, type IBufferLine } from '@xterm/xterm';

export interface TranscriptSpan {
  text: string;
  foreground?: string;
  background?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
}

export interface TranscriptRecord {
  id: string;
  text: string;
  spans: TranscriptSpan[];
  transient: boolean;
}

export class TerminalTranscriptFollowController {
  private following = true;

  constructor(private readonly bottomThreshold = 48) {}

  observe(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }): void {
    const distance = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
    this.following = distance <= this.bottomThreshold;
  }

  shouldFollowNewOutput(): boolean {
    return this.following;
  }
}

export class TerminalTranscriptProjector {
  private readonly terminal: Terminal;

  constructor(options: { cols: number; rows: number; scrollback?: number }) {
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback ?? 5_000,
      convertEol: false,
      allowProposedApi: true
    });
  }

  write(data: string): Promise<void> {
    return new Promise((resolve) => this.terminal.write(data, resolve));
  }

  reset(data = ''): Promise<void> {
    this.terminal.reset();
    return data ? this.write(data) : Promise.resolve();
  }

  resize(cols: number, rows: number): void {
    if (cols === this.terminal.cols && rows === this.terminal.rows) return;
    this.terminal.resize(cols, rows);
  }

  records(): TranscriptRecord[] {
    const buffer = this.terminal.buffer.active;
    const records: TranscriptRecord[] = [];
    let row = 0;
    while (row < buffer.length) {
      const startRow = row;
      const spans: TranscriptSpan[] = [];
      do {
        const line = buffer.getLine(row);
        if (line) {
          const next = buffer.getLine(row + 1);
          appendLine(spans, line, next?.isWrapped === true, this.terminal.cols);
        }
        row += 1;
      } while (row < buffer.length && buffer.getLine(row)?.isWrapped === true);

      const text = spans.map((span) => span.text).join('');
      if (text.length === 0 && startRow >= buffer.baseY + buffer.cursorY) continue;
      records.push({
        id: `${startRow < buffer.baseY ? 'stable' : 'screen'}-${startRow}`,
        text,
        spans,
        transient: startRow >= buffer.baseY
      });
    }
    return records;
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

function appendLine(
  spans: TranscriptSpan[],
  line: IBufferLine,
  continues: boolean,
  cols: number
): void {
  const end = continues ? cols : lastContentColumn(line, cols);
  for (let column = 0; column < end; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    const text = cell.getChars() || ' ';
    const style = cellStyle(cell);
    const previous = spans.at(-1);
    if (previous && sameStyle(previous, style)) previous.text += text;
    else spans.push({ text, ...style });
  }
}

function lastContentColumn(line: IBufferLine, cols: number): number {
  for (let column = cols - 1; column >= 0; column -= 1) {
    const cell = line.getCell(column);
    if (!cell) continue;
    if (cell.getChars() || cell.getCode() !== 0) return column + 1;
  }
  return 0;
}

function cellStyle(cell: IBufferCell): Omit<TranscriptSpan, 'text'> {
  let foreground = terminalColor(cell, 'foreground');
  let background = terminalColor(cell, 'background');
  if (cell.isInverse()) [foreground, background] = [background, foreground];
  return {
    ...(foreground ? { foreground } : {}),
    ...(background ? { background } : {}),
    ...(cell.isBold() ? { bold: true } : {}),
    ...(cell.isItalic() ? { italic: true } : {}),
    ...(cell.isUnderline() ? { underline: true } : {}),
    ...(cell.isDim() ? { dim: true } : {}),
    ...(cell.isStrikethrough() ? { strikethrough: true } : {})
  };
}

function sameStyle(left: TranscriptSpan, right: Omit<TranscriptSpan, 'text'>): boolean {
  return left.foreground === right.foreground
    && left.background === right.background
    && left.bold === right.bold
    && left.italic === right.italic
    && left.underline === right.underline
    && left.dim === right.dim
    && left.strikethrough === right.strikethrough;
}

function terminalColor(cell: IBufferCell, kind: 'foreground' | 'background'): string | undefined {
  const isDefault = kind === 'foreground' ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return undefined;
  const isRgb = kind === 'foreground' ? cell.isFgRGB() : cell.isBgRGB();
  const color = kind === 'foreground' ? cell.getFgColor() : cell.getBgColor();
  if (isRgb) return `#${color.toString(16).padStart(6, '0')}`;
  return ansiColor(color);
}

const ANSI_16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543',
  '#3b8eea', '#d670d6', '#29b8db', '#ffffff'
] as const;

function ansiColor(index: number): string {
  if (index < ANSI_16.length) return ANSI_16[index]!;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return rgb(level, level, level);
  }
  const value = index - 16;
  const red = Math.floor(value / 36);
  const green = Math.floor((value % 36) / 6);
  const blue = value % 6;
  const channel = (component: number) => component === 0 ? 0 : 55 + component * 40;
  return rgb(channel(red), channel(green), channel(blue));
}

function rgb(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((component) => component.toString(16).padStart(2, '0'))
    .join('')}`;
}
