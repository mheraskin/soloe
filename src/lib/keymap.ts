export interface KeymapBinding {
  id: string;
  description: string;
  keys: string[];
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
    keys: ['Ctrl', 'K'],
    match: (e: KeyboardEvent) => isPlainCtrlOrCmd(e) && key(e) === 'k'
  },
  filePalette: {
    id: 'command.file-palette',
    description: 'Open file palette',
    keys: ['Ctrl', 'P'],
    match: (e: KeyboardEvent) => isPlainCtrlOrCmd(e) && key(e) === 'p'
  },
  openSettings: {
    id: 'settings.open',
    description: 'Open settings',
    keys: ['Ctrl', ','],
    match: (e: KeyboardEvent) => isPlainCtrlOrCmd(e) && key(e) === ','
  },
  newSession: {
    id: 'session.new',
    description: 'New session',
    keys: ['Ctrl', 'T'],
    match: (e: KeyboardEvent) => isPlainCtrlOrCmd(e) && key(e) === 't'
  },
  newSessionPicker: {
    id: 'session.new-pick-kind',
    description: 'New session (pick kind)',
    keys: ['Ctrl', 'Shift', 'T'],
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && e.shiftKey && !e.altKey && key(e) === 't'
  },
  openProject: {
    id: 'project.open',
    description: 'Open project',
    keys: ['Ctrl', 'Shift', 'O'],
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && e.shiftKey && !e.altKey && key(e) === 'o'
  },
  terminalFind: {
    id: 'terminal.find',
    description: 'Find in terminal',
    keys: ['Ctrl', 'F'],
    match: (e: KeyboardEvent) => isPlainCtrlOrCmd(e) && key(e) === 'f'
  },
  zoomIn: {
    id: 'window.zoom-in',
    description: 'Zoom in',
    keys: ['Ctrl', '+'],
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && !e.altKey && (key(e) === '+' || key(e) === '=')
  },
  zoomOut: {
    id: 'window.zoom-out',
    description: 'Zoom out',
    keys: ['Ctrl', '-'],
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && !e.altKey && (key(e) === '-' || key(e) === '_')
  },
  deleteSelectedSession: {
    id: 'session.delete-selected',
    description: 'Delete selected session',
    keys: ['Del'],
    match: (e: KeyboardEvent) =>
      !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'Delete'
  },
  cycleNext: {
    id: 'tabs.cycle-next',
    description: 'Switch to next session',
    keys: ['Ctrl', 'Shift', ']'],
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && e.shiftKey && !e.altKey && key(e) === ']'
  },
  cyclePrev: {
    id: 'tabs.cycle-prev',
    description: 'Switch to previous session',
    keys: ['Ctrl', 'Shift', '['],
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && e.shiftKey && !e.altKey && key(e) === '['
  },
  toggleNotesRail: {
    id: 'rail.toggle-notes',
    description: 'Toggle Notes pane',
    keys: ['Ctrl', 'Shift', 'N'],
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && e.shiftKey && !e.altKey && key(e) === 'n'
  },
  toggleDiffRail: {
    id: 'rail.toggle-diff',
    description: 'Toggle working diff pane',
    keys: ['Ctrl', 'Shift', 'D'],
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && e.shiftKey && !e.altKey && key(e) === 'd'
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

export function projectIndexFromEvent(e: KeyboardEvent): number | null {
  if (!isCtrlOrCmd(e) || e.altKey || !e.shiftKey) return null;
  const m = e.code.match(/^Digit([1-9])$/);
  if (!m) return null;
  return Number(m[1]) - 1;
}

export function shouldIgnoreInTextInput(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}
