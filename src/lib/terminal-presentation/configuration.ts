import type { TerminalPresentationConfiguration } from './types';

export function defaultTerminalPresentationConfiguration(
  fontSize: number,
  scrollback: number
): TerminalPresentationConfiguration {
  return {
    fontFamily: 'JetBrains Mono, Cascadia Code, ui-monospace, monospace',
    fontSize,
    fontWeight: 400,
    fontWeightBold: 700,
    // Integer line height prevents per-DPR row rounding from shifting animated TUIs.
    lineHeight: 1,
    letterSpacing: 0,
    minimumContrastRatio: 4.5,
    cursorStyle: 'bar',
    cursorWidth: 2,
    cursorInactiveStyle: 'outline',
    unicodeVersion: '11',
    scrollback,
    theme: {
      background: '#0f0f10',
      foreground: '#e6e6e6',
      cursor: '#e6e6e6',
      cursorAccent: '#0f0f10',
      selectionBackground: '#283457',
      selectionForeground: '#e6e6e6',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#ff899d',
      brightGreen: '#9fe044',
      brightYellow: '#faba4a',
      brightBlue: '#8db0ff',
      brightMagenta: '#c7a9ff',
      brightCyan: '#a4daff',
      brightWhite: '#e6e6e6'
    }
  };
}
