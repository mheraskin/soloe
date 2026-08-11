import type { TerminalPresentationCreateRequest, TerminalPresentationSize } from './types';

export interface NativeTerminalHostCapabilities {
  available: boolean;
  complete: boolean;
  platform?: string;
  implementation?: string;
  reason?: string;
}

export interface NativeTerminalSurface {
  write(data: string): Promise<void>;
  replace(data: string): Promise<void>;
  setVisible(visible: boolean): Promise<void>;
  setFocused(focused: boolean): Promise<void>;
  setBounds(bounds: DOMRectReadOnly): Promise<TerminalPresentationSize | null>;
  setConfiguration(request: TerminalPresentationCreateRequest['configuration']): Promise<void>;
  paste(text: string): Promise<void>;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  find(query: string, direction: 'next' | 'previous'): Promise<boolean>;
  exportBuffer(): Promise<string>;
  scrollToBottom(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Shell-side boundary for native terminal surfaces. Implementations may use
 * Tauri, Electron, Zig, C, or platform UI internally; none of those details are
 * visible to the Terminal Presentation Interface.
 */
export interface NativeTerminalHost {
  capabilities(): Promise<NativeTerminalHostCapabilities>;
  createSurface(request: TerminalPresentationCreateRequest): Promise<NativeTerminalSurface>;
}
