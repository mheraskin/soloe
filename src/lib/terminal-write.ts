export const FULL_TERMINAL_SCROLLBACK = 4_294_967_295;

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
