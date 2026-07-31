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
  if (input.type !== 'keyDown' || input.alt) return false;

  const key = input.key.toLowerCase();
  const isControlShiftI =
    key === 'i' && input.control && input.shift && !input.meta;
  const isMacCommandShiftC =
    platform === 'darwin' && key === 'c' && input.meta && input.shift && !input.control;

  return isControlShiftI || isMacCommandShiftC;
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
