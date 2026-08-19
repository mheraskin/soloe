import type { GhosttyColor, GhosttyTheme } from './ghostty/core';
import type { ResolvedTheme } from '../stores/appearance-theme.svelte';

export const terminalFontFamily = 'JetBrains Mono, Cascadia Code, ui-monospace, monospace';

export const darkTerminalTheme: GhosttyTheme = {
  background: hexColor('#0f0f10'),
  foreground: hexColor('#e6e6e6'),
  cursor: hexColor('#e6e6e6'),
  selectionBackground: '#283457'
};

export const lightTerminalTheme: GhosttyTheme = {
  background: hexColor('#f7f8fa'),
  foreground: hexColor('#24292f'),
  cursor: hexColor('#9a4f24'),
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
