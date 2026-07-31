export interface BrowserShortcutInput {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export function isBrowserDevToolsToggleInput(
  input: BrowserShortcutInput,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (input.type !== 'keyDown') return false;

  const key = input.key.toLowerCase();
  const isControlShiftI =
    key === 'i' && input.control && input.shift && !input.meta && !input.alt;
  const isMacCommandShiftC =
    platform === 'darwin'
    && key === 'c'
    && input.meta
    && input.shift
    && !input.control
    && !input.alt;
  const isMacCommandOptionI =
    platform === 'darwin'
    && key === 'i'
    && input.meta
    && input.alt
    && !input.control
    && !input.shift;

  return isControlShiftI || isMacCommandShiftC || isMacCommandOptionI;
}

export function isBrowserRestoreTabInput(
  input: BrowserShortcutInput,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (input.type !== 'keyDown' || input.alt || !input.shift) return false;
  if (input.key.toLowerCase() !== 't') return false;

  if (platform === 'darwin') {
    return input.meta && !input.control;
  }
  return input.control && !input.meta;
}
