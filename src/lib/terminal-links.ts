import type { ILinkHandler } from '@xterm/xterm';

export interface TerminalLinkHandlers {
  osc: ILinkHandler;
  web: (event: MouseEvent, uri: string) => void;
}

/** Routes xterm's OSC 8 and detected plain-text links through one safe owner. */
export function terminalLinkHandlers(open: (uri: string) => void): TerminalLinkHandlers {
  const activate = (_event: MouseEvent, uri: string): void => open(uri);
  return {
    osc: { activate },
    web: activate
  };
}
