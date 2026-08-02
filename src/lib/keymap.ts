import { ELEMENT_SOURCE_INSPECTOR_SHORTCUT, shortcutSignature } from './element-source-inspector';

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
  browserDevTools: {
    id: 'browser.devtools',
    description: 'Toggle browser developer tools',
    keys: ['Ctrl', 'Shift', 'I'],
    match: (e: KeyboardEvent) =>
      (e.ctrlKey && !e.metaKey && e.shiftKey && !e.altKey && key(e) === 'i')
      || (e.metaKey && !e.ctrlKey && !e.shiftKey && e.altKey && key(e) === 'i')
      || (e.metaKey && !e.ctrlKey && e.shiftKey && !e.altKey && key(e) === 'c')
  },
  elementSourceInspector: {
    id: 'browser.element-source-inspector',
    description: 'Toggle Element Source Inspector',
    keys: [...ELEMENT_SOURCE_INSPECTOR_SHORTCUT],
    match: (e: KeyboardEvent) => matchesShortcut(e, ELEMENT_SOURCE_INSPECTOR_SHORTCUT)
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
  zoomReset: {
    id: 'window.zoom-reset',
    description: 'Reset zoom',
    keys: ['Ctrl', '0'],
    match: (e: KeyboardEvent) => isPlainCtrlOrCmd(e) && key(e) === '0'
  },
  deleteSelectedSession: {
    id: 'session.delete-selected',
    description: 'Delete selected session',
    keys: ['Ctrl', 'Del'],
    match: (e: KeyboardEvent) => isPlainCtrlOrCmd(e) && e.key === 'Delete'
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
  toggleSidebar: {
    id: 'sidebar.toggle',
    description: 'Toggle sidebar',
    keys: ['Ctrl', 'B'],
    match: (e: KeyboardEvent) => isPlainCtrlOrCmd(e) && key(e) === 'b'
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
  },
  toggleFilesRail: {
    id: 'rail.toggle-files',
    description: 'Toggle Files pane',
    keys: ['Ctrl', 'Shift', 'E'],
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && e.shiftKey && !e.altKey && key(e) === 'e'
  },
  toggleFeatureRail: {
    id: 'rail.toggle-feature',
    description: 'Toggle Feature Lab pane',
    keys: ['Ctrl', 'Shift', 'L'],
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && e.shiftKey && !e.altKey && key(e) === 'l'
  },
  toggleBrowserRail: {
    id: 'rail.toggle-browser',
    description: 'Toggle Browser pane',
    keys: ['Ctrl', 'Shift', 'B'],
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && e.shiftKey && !e.altKey && key(e) === 'b'
  },
  toggleRailFullscreen: {
    id: 'rail.fullscreen',
    description: 'Toggle right pane fullscreen',
    keys: ['Ctrl', 'Shift', 'M'],
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && e.shiftKey && !e.altKey && key(e) === 'm'
  },
  toggleTerminalFocus: {
    id: 'focus.toggle-terminal',
    description: 'Toggle focus between terminal and right pane',
    keys: ['Ctrl', ';'],
    match: (e: KeyboardEvent) => isPlainCtrlOrCmd(e) && key(e) === ';'
  },
  splitTerminal: {
    id: 'terminal.split',
    description: 'Split terminal',
    keys: ['Ctrl', 'Shift', '/'],
    // Shift+/ resolves to "?" in `e.key`, so match on the physical key code.
    match: (e: KeyboardEvent) =>
      isCtrlOrCmd(e) && e.shiftKey && !e.altKey && e.code === 'Slash'
  }
} as const satisfies Record<string, KeymapBinding>;

export function matchesShortcut(e: KeyboardEvent, keys: readonly string[]): boolean {
  const normalized = keys.map((value) => value.trim().toLowerCase()).filter(Boolean);
  const hasCtrl = normalized.includes('ctrl') || normalized.includes('cmd');
  const hasAlt = normalized.includes('alt') || normalized.includes('option');
  const hasShift = normalized.includes('shift');
  const keyToken = normalized.find(
    (value) => !['ctrl', 'cmd', 'alt', 'option', 'shift', 'meta'].includes(value)
  );
  if (!keyToken) return false;
  if (hasCtrl !== isCtrlOrCmd(e)) return false;
  if (hasAlt !== e.altKey || hasShift !== e.shiftKey) return false;
  if (normalized.includes('meta') !== e.metaKey && normalized.includes('meta')) return false;
  if (!hasCtrl && (e.ctrlKey || e.metaKey)) return false;
  return key(e) === keyToken || physicalKey(e) === keyToken;
}

export function shortcutKeysFromEvent(e: KeyboardEvent): string[] | null {
  if (e.key === 'Control' || e.key === 'Meta' || e.key === 'Alt' || e.key === 'Shift') return null;
  const keyToken = physicalKey(e) || key(e);
  if (!keyToken) return null;
  const keys: string[] = [];
  if (isCtrlOrCmd(e)) keys.push('Ctrl');
  if (e.altKey) keys.push('Alt');
  if (e.shiftKey) keys.push('Shift');
  keys.push(keyToken.length === 1 ? keyToken.toUpperCase() : keyToken);
  return keys;
}

export function shortcutConflicts(
  keys: readonly string[],
  exceptId = Keymap.elementSourceInspector.id
): KeymapBinding[] {
  const signature = shortcutSignature(keys);
  return Object.values(Keymap).filter(
    (binding) => binding.id !== exceptId && shortcutSignature(binding.keys) === signature
  );
}

function physicalKey(e: KeyboardEvent): string {
  const codeMap: Record<string, string> = {
    Slash: '/',
    Semicolon: ';',
    Comma: ',',
    Period: '.',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']'
  };
  return codeMap[e.code] ?? '';
}

export function tabIndexFromEvent(e: KeyboardEvent): number | null {
  if (!isPlainCtrlOrCmd(e)) return null;
  const k = key(e);
  if (k.length === 1 && k >= '1' && k <= '9') {
    return Number(k) - 1;
  }
  return null;
}

export function shiftNumberIndexFromEvent(e: KeyboardEvent): number | null {
  if (!isCtrlOrCmd(e) || e.altKey || !e.shiftKey) return null;
  const m = e.code.match(/^Digit([1-9])$/);
  if (!m) return null;
  return Number(m[1]) - 1;
}

// Keep in-flight HMR clients compatible while the shortcut helper rename propagates.
export const worktreeIndexFromEvent = shiftNumberIndexFromEvent;

export function shouldIgnoreInTextInput(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}
