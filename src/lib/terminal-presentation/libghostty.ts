import type {
  TerminalPresentation,
  TerminalPresentationConfiguration,
  TerminalPresentationCreateRequest
} from './types';
import type { NativeTerminalHost, NativeTerminalSurface } from './native-host';

/**
 * Thin renderer-side Adapter for a shell-owned libghostty surface.
 *
 * The native host owns only the surface. PTY bytes still enter and leave
 * through the Renderer Backend Interface and the Environment Runtime.
 */
export class LibghosttyTerminalPresentationAdapter implements TerminalPresentation {
  readonly kind = 'libghostty' as const;

  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private visible: boolean;
  private focused: boolean;
  private compactViewport: boolean;

  private constructor(
    private readonly request: TerminalPresentationCreateRequest,
    private readonly surface: NativeTerminalSurface
  ) {
    this.visible = request.visible;
    this.focused = request.focused;
    this.compactViewport = request.compactViewport;
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(request.host);
    window.addEventListener('soloe:rail-layout', this.onRailLayout);
  }

  static async create(
    host: NativeTerminalHost,
    request: TerminalPresentationCreateRequest
  ): Promise<LibghosttyTerminalPresentationAdapter> {
    const surface = await host.createSurface(request);
    try {
      const adapter = new LibghosttyTerminalPresentationAdapter(request, surface);
      await surface.setConfiguration(request.configuration);
      await surface.setVisible(request.visible);
      await surface.setFocused(request.focused);
      adapter.fit();
      return adapter;
    } catch (error) {
      await surface.dispose().catch(() => {});
      throw error;
    }
  }

  write(data: string): Promise<void> {
    return this.disposed ? Promise.resolve() : this.surface.write(data);
  }

  replace(data: string): Promise<void> {
    return this.disposed ? Promise.resolve() : this.surface.replace(data);
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    void this.surface.setVisible(visible);
    if (visible) this.fit();
  }

  setFocused(focused: boolean, _autofocus: boolean): void {
    if (this.disposed || this.focused === focused) return;
    this.focused = focused;
    void this.surface.setFocused(focused);
  }

  setCompactViewport(compact: boolean): void {
    this.compactViewport = compact;
  }

  setConfiguration(configuration: TerminalPresentationConfiguration): void {
    if (this.disposed) return;
    void this.surface.setConfiguration(configuration).then(() => this.fit());
  }

  fit(scrollToBottom = false): void {
    if (this.disposed || !this.visible || !this.request.host.isConnected) return;
    if (
      this.compactViewport
      && document.documentElement.hasAttribute('data-mobile-keyboard-open')
    ) return;
    const bounds = this.request.host.getBoundingClientRect();
    if (bounds.width < 4 || bounds.height < 4) return;
    void this.surface.setBounds(bounds).then((size) => {
      if (size) this.request.callbacks.onResize(size);
      if (scrollToBottom) void this.surface.scrollToBottom();
    });
  }

  focus(): void {
    if (!this.disposed) void this.surface.setFocused(true);
  }

  paste(text: string): void {
    if (!this.disposed) void this.surface.paste(text);
  }

  hasSelection(): boolean {
    return !this.disposed && this.surface.hasSelection();
  }

  getSelection(): string {
    return this.disposed ? '' : this.surface.getSelection();
  }

  clearSelection(): void {
    if (!this.disposed) this.surface.clearSelection();
  }

  find(query: string, direction: 'next' | 'previous'): Promise<boolean> {
    return this.disposed ? Promise.resolve(false) : this.surface.find(query, direction);
  }

  exportBuffer(): Promise<string> {
    return this.disposed ? Promise.resolve('') : this.surface.exportBuffer();
  }

  scrollToBottom(): void {
    if (!this.disposed) void this.surface.scrollToBottom();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener('soloe:rail-layout', this.onRailLayout);
    void this.surface.dispose();
  }

  private readonly onRailLayout = (event: Event): void => {
    const detail = (event as CustomEvent<{ keyboardOpen?: boolean; keyboardClosed?: boolean }>).detail;
    if (detail?.keyboardOpen) {
      void this.surface.scrollToBottom();
    } else if (detail?.keyboardClosed) {
      requestAnimationFrame(() => requestAnimationFrame(() => this.fit(true)));
    } else {
      this.fit();
    }
  };
}
