export interface ChordMatch {
  ctrlOrCmd: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

export interface KeymapBinding {
  id: string;
  description: string;
  match: (e: KeyboardEvent) => boolean;
}

function isCtrlOrCmd(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

function isPlainCtrlOrCmd(e: KeyboardEvent): boolean {
  return isCtrlOrCmd(e) && !e.shiftKey && !e.altKey;
}

function key(e: KeyboardEvent): string {
  return e.key.toLowerCase();
}

export const Keymap = {
  commandPalette: {
    id: 'command.palette',
    description: 'Open command palette',
    match: (e: KeyboardEvent) => isPlainCtrlOrCmd(e) && key(e) === 'k'
  },
  filePalette: {
    id: 'command.file-palette',
    description: 'Open file palette',
    match: (e: KeyboardEvent) => isPlainCtrlOrCmd(e) && key(e) === 'p'
  },
  terminalFind: {
    id: 'terminal.find',
    description: 'Find in terminal',
    match: (e: KeyboardEvent) => isPlainCtrlOrCmd(e) && key(e) === 'f'
  },
  closeActiveTab: {
    id: 'tabs.close-active',
    description: 'Close active tab',
    match: (e: KeyboardEvent) => isPlainCtrlOrCmd(e) && key(e) === 'w'
  },
  cycleNext: {
    id: 'tabs.cycle-next',
    description: 'Switch to next tab',
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && e.shiftKey && !e.altKey && (key(e) === ']' || key(e) === 'tab')
  },
  cyclePrev: {
    id: 'tabs.cycle-prev',
    description: 'Switch to previous tab',
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && e.shiftKey && !e.altKey && (key(e) === '[' || (key(e) === 'tab' && e.shiftKey))
  }
} as const satisfies Record<string, KeymapBinding>;

export function tabIndexFromEvent(e: KeyboardEvent): number | null {
  if (!isPlainCtrlOrCmd(e)) return null;
  const k = key(e);
  if (k.length === 1 && k >= '1' && k <= '9') {
    return Number(k) - 1;
  }
  return null;
}

export function shouldIgnoreInTextInput(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}
