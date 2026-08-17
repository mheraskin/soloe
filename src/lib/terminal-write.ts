// Keep the browser viewport bounded. Durable restore comes from the Runtime's
// headless screen snapshot plus sequence replay, not an effectively-unbounded
// renderer buffer.
export const FULL_TERMINAL_SCROLLBACK = 10_000;

interface WritableTerminal {
  write(data: string, callback: () => void): void;
  reset(): void;
  scrollToBottom(): void;
}

export function writeTerminalData(
  terminal: WritableTerminal,
  data: string,
  options: {
    replace?: boolean;
    onSettled?: (byteCount: number) => void;
  } = {}
): Promise<void> {
  if (options.replace) terminal.reset();
  return new Promise((resolve) => {
    terminal.write(data, () => {
      if (options.replace) terminal.scrollToBottom();
      options.onSettled?.(data.length);
      resolve();
    });
  });
}
