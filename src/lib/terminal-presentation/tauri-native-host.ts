import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  NativeTerminalHost,
  NativeTerminalHostCapabilities,
  NativeTerminalSurface
} from './native-host';
import type {
  TerminalPresentationConfiguration,
  TerminalPresentationCreateRequest,
  TerminalPresentationSize
} from './types';

interface NativeSurfaceEvent {
  surfaceId: string;
  data?: string;
  text?: string;
}

class TauriNativeTerminalSurface implements NativeTerminalSurface {
  private selection = '';
  private unlisteners: UnlistenFn[] = [];

  constructor(
    private readonly surfaceId: string,
    private readonly request: TerminalPresentationCreateRequest
  ) {}

  async initialize(): Promise<void> {
    this.unlisteners.push(
      await listen<NativeSurfaceEvent>('soloe://native-terminal-input', ({ payload }) => {
        if (payload.surfaceId === this.surfaceId && payload.data) {
          this.request.callbacks.onInput(payload.data);
        }
      }),
      await listen<NativeSurfaceEvent>('soloe://native-terminal-selection', ({ payload }) => {
        if (payload.surfaceId === this.surfaceId) {
          this.selection = payload.text ?? '';
          this.request.callbacks.onSelectionChange?.(this.selection);
        }
      }),
      await listen<NativeSurfaceEvent>('soloe://native-terminal-link', ({ payload }) => {
        if (payload.surfaceId === this.surfaceId && payload.text) {
          this.request.callbacks.onLink(payload.text);
        }
      })
    );
  }

  write(data: string): Promise<void> {
    return invoke('native_terminal_write', { surfaceId: this.surfaceId, data });
  }

  replace(data: string): Promise<void> {
    return invoke('native_terminal_replace', { surfaceId: this.surfaceId, data });
  }

  setVisible(visible: boolean): Promise<void> {
    return invoke('native_terminal_set_visible', { surfaceId: this.surfaceId, visible });
  }

  setFocused(focused: boolean): Promise<void> {
    return invoke('native_terminal_set_focused', { surfaceId: this.surfaceId, focused });
  }

  setBounds(bounds: DOMRectReadOnly): Promise<TerminalPresentationSize | null> {
    return invoke('native_terminal_set_bounds', {
      surfaceId: this.surfaceId,
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    });
  }

  setConfiguration(configuration: TerminalPresentationConfiguration): Promise<void> {
    return invoke('native_terminal_set_configuration', {
      surfaceId: this.surfaceId,
      configuration
    });
  }

  paste(text: string): Promise<void> {
    return invoke('native_terminal_paste', { surfaceId: this.surfaceId, text });
  }

  hasSelection(): boolean {
    return this.selection.length > 0;
  }

  getSelection(): string {
    return this.selection;
  }

  clearSelection(): void {
    this.selection = '';
    void invoke('native_terminal_clear_selection', { surfaceId: this.surfaceId });
  }

  find(query: string, direction: 'next' | 'previous'): Promise<boolean> {
    return invoke('native_terminal_find', { surfaceId: this.surfaceId, query, direction });
  }

  exportBuffer(): Promise<string> {
    return invoke('native_terminal_export_buffer', { surfaceId: this.surfaceId });
  }

  scrollToBottom(): Promise<void> {
    return invoke('native_terminal_scroll_to_bottom', { surfaceId: this.surfaceId });
  }

  async dispose(): Promise<void> {
    for (const unlisten of this.unlisteners.splice(0)) unlisten();
    await invoke('native_terminal_dispose', { surfaceId: this.surfaceId });
  }
}

class TauriNativeTerminalHost implements NativeTerminalHost {
  async capabilities(): Promise<NativeTerminalHostCapabilities> {
    try {
      return await invoke<NativeTerminalHostCapabilities>('native_terminal_capabilities');
    } catch (error) {
      return {
        available: false,
        complete: false,
        implementation: 'tauri-libghostty',
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async createSurface(request: TerminalPresentationCreateRequest): Promise<NativeTerminalSurface> {
    const bounds = request.host.getBoundingClientRect();
    const surfaceId = await invoke<string>('native_terminal_create', {
      request: {
        terminalId: request.terminalId,
        sessionId: request.sessionId,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        configuration: request.configuration,
        visible: request.visible,
        focused: request.focused
      }
    });
    const surface = new TauriNativeTerminalSurface(surfaceId, request);
    await surface.initialize();
    return surface;
  }
}

export const tauriNativeTerminalHost: NativeTerminalHost = new TauriNativeTerminalHost();
