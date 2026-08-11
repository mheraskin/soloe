import type { SessionId } from '@shared/types/sessions.js';
import type { TerminalId } from '@shared/types/terminal.js';

export type TerminalPresentationKind = 'xterm' | 'libghostty';
export type TerminalPresentationPreference = TerminalPresentationKind | 'auto';

export interface TerminalPresentationSize {
  cols: number;
  rows: number;
}

export interface TerminalPresentationTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TerminalPresentationConfiguration {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontWeightBold: number;
  lineHeight: number;
  letterSpacing: number;
  minimumContrastRatio: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorWidth: number;
  cursorInactiveStyle: 'outline' | 'block' | 'bar' | 'underline' | 'none';
  unicodeVersion: '11';
  scrollback: number;
  theme: TerminalPresentationTheme;
}

export interface TerminalPresentationCallbacks {
  onInput(data: string): void;
  onResize(size: TerminalPresentationSize): void;
  onSelectionChange?(selection: string): void;
  onLink(uri: string): void;
  onKey(event: KeyboardEvent): boolean;
  onRendererFailure?(detail: {
    renderer: 'webgl' | 'canvas' | 'native';
    error: unknown;
    recovered: boolean;
  }): void;
}

export interface TerminalPresentationCreateRequest {
  terminalId: TerminalId;
  sessionId: SessionId;
  host: HTMLElement;
  configuration: TerminalPresentationConfiguration;
  visible: boolean;
  focused: boolean;
  compactViewport: boolean;
  callbacks: TerminalPresentationCallbacks;
}

/**
 * Shell-neutral terminal presentation behavior used by the Svelte UI.
 *
 * Implementations render terminal state only. The Environment Runtime remains
 * the exclusive owner of PTYs, replay, input, resize, stop, and observation.
 * No xterm object, native surface handle, Tauri command, or Ghostty type crosses
 * this Interface.
 */
export interface TerminalPresentation {
  readonly kind: TerminalPresentationKind;
  write(data: string): Promise<void>;
  replace(data: string): Promise<void>;
  setVisible(visible: boolean): void;
  setFocused(focused: boolean, autofocus: boolean): void;
  setCompactViewport(compact: boolean): void;
  setConfiguration(configuration: TerminalPresentationConfiguration): void;
  fit(scrollToBottom?: boolean): void;
  focus(): void;
  paste(text: string): void;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  find(query: string, direction: 'next' | 'previous'): Promise<boolean>;
  exportBuffer(): Promise<string>;
  scrollToBottom(): void;
  dispose(): void;
}

export interface TerminalPresentationFactory {
  create(request: TerminalPresentationCreateRequest): Promise<TerminalPresentation>;
}
