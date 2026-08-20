import type { GhosttyColor, GhosttyTheme } from './ghostty/core';
import type { ResolvedTheme } from '../stores/appearance-theme.svelte';

export const terminalFontFamily = 'JetBrains Mono, Cascadia Code, ui-monospace, monospace';

export const darkTerminalTheme: GhosttyTheme = {
  background: hexColor('#0f0f10'),
  foreground: hexColor('#e6e6e6'),
  cursor: hexColor('#e6e6e6'),
  palette: terminalPalette([
    '#15161e', '#f7768e', '#9ece6a', '#e0af68',
    '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
    '#414868', '#ff899d', '#9fe044', '#faba4a',
    '#8db0ff', '#c7a9ff', '#a4daff', '#e6e6e6'
  ]),
  selectionBackground: '#283457'
};

export const lightTerminalTheme: GhosttyTheme = {
  background: hexColor('#f7f8fa'),
  foreground: hexColor('#24292f'),
  cursor: hexColor('#9a4f24'),
  palette: terminalPalette([
    '#24292f', '#cf222e', '#1a7f37', '#9a6700',
    '#0969da', '#8250df', '#0a7a82', '#6e7781',
    '#57606a', '#a40e26', '#116329', '#7d4e00',
    '#0550ae', '#6639ba', '#08656c', '#1f2328'
  ]),
  selectionBackground: '#c9d8f0'
};

export function terminalThemeFor(theme: ResolvedTheme): GhosttyTheme {
  return theme === 'dark' ? darkTerminalTheme : lightTerminalTheme;
}

function hexColor(value: `#${string}`): GhosttyColor {
  const red = Number.parseInt(value.slice(1, 3), 16);
  const green = Number.parseInt(value.slice(3, 5), 16);
  const blue = Number.parseInt(value.slice(5, 7), 16);
  return { r: red, g: green, b: blue };
}

function terminalPalette(ansi16: readonly `#${string}`[]): readonly GhosttyColor[] {
  const palette = ansi16.map(hexColor);
  const cube = [0, 95, 135, 175, 215, 255];
  for (const red of cube) {
    for (const green of cube) {
      for (const blue of cube) palette.push({ r: red, g: green, b: blue });
    }
  }
  for (let index = 0; index < 24; index += 1) {
    const value = 8 + index * 10;
    palette.push({ r: value, g: value, b: value });
  }
  return palette;
}
