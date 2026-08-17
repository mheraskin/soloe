import type { ITheme } from '@xterm/xterm';
import type { ResolvedTheme } from '../stores/appearance-theme.svelte';

export const terminalFontFamily = 'JetBrains Mono, Cascadia Code, ui-monospace, monospace';

export const darkTerminalTheme: ITheme = {
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
};

export const lightTerminalTheme: ITheme = {
  background: '#f7f8fa',
  foreground: '#24292f',
  cursor: '#9a4f24',
  cursorAccent: '#f7f8fa',
  selectionBackground: '#c9d8f0',
  selectionForeground: '#17202a',
  black: '#24292f',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#0a7a82',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#116329',
  brightYellow: '#7d4e00',
  brightBlue: '#0550ae',
  brightMagenta: '#6639ba',
  brightCyan: '#08656c',
  brightWhite: '#1f2328'
};

export function terminalThemeFor(theme: ResolvedTheme): ITheme {
  return theme === 'dark' ? darkTerminalTheme : lightTerminalTheme;
}

const transcriptAnsi16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543',
  '#3b8eea', '#d670d6', '#29b8db', '#ffffff'
] as const;

const themeAnsiKeys = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
] as const satisfies ReadonlyArray<keyof ITheme>;

export function terminalTranscriptColor(color: string, theme: ResolvedTheme): string {
  const index = transcriptAnsi16.indexOf(color.toLowerCase() as typeof transcriptAnsi16[number]);
  if (index === -1) return color;
  return terminalThemeFor(theme)[themeAnsiKeys[index]!] ?? color;
}
