import type {
  TerminalPresentation,
  TerminalPresentationConfiguration,
  TerminalPresentationCreateRequest
} from './types';
import type { NativeTerminalHost, NativeTerminalSurface } from './native-host';
import {
  isNativeSurfaceBlocked,
  subscribeNativeSurfaceBlocker
} from '../native-surface-layout';

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
  private blocked = isNativeSurfaceBlocked();
  private surfaceVisible: boolean;
  private resizeFrame: number | null = null;
  private resizeRequested = false;
  private resizeInFlight = false;
  private scrollAfterFit = false;
  private readonly unsubscribeBlocker: () => void;

  private constructor(
    private readonly request: TerminalPresentationCreateRequest,
    private readonly surface: NativeTerminalSurface
  ) {
    this.visible = request.visible;
    this.focused = request.focused;
    this.compactViewport = request.compactViewport;
    this.surfaceVisible = request.visible && !this.blocked;
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(request.host);
    this.unsubscribeBlocker = subscribeNativeSurfaceBlocker(this.onSurfaceBlocked);
    window.addEventListener('soloe:rail-layout', this.onRailLayout);
    window.addEventListener('soloe:renderer-zoom', this.onRendererZoom);
  }

  static async create(
    host: NativeTerminalHost,
    request: TerminalPresentationCreateRequest
  ): Promise<LibghosttyTerminalPresentationAdapter> {
    const surface = await host.createSurface(request);
    try {
      const adapter = new LibghosttyTerminalPresentationAdapter(request, surface);
      await surface.setConfiguration(request.configuration);
      await surface.setVisible(adapter.surfaceVisible);
      await surface.setFocused(request.focused && !adapter.blocked);
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
    this.syncSurfaceVisibility();
  }

  setFocused(focused: boolean, _autofocus: boolean): void {
    if (this.disposed || this.focused === focused) return;
    this.focused = focused;
    if (!this.blocked) void this.surface.setFocused(focused);
  }

  setCompactViewport(compact: boolean): void {
    this.compactViewport = compact;
  }

  setConfiguration(configuration: TerminalPresentationConfiguration): void {
    if (this.disposed) return;
    void this.surface.setConfiguration(configuration).then(() => this.fit());
  }

  fit(scrollToBottom = false): void {
    if (this.disposed || !this.visible || this.blocked || !this.request.host.isConnected) return;
    if (
      this.compactViewport
      && document.documentElement.hasAttribute('data-mobile-keyboard-open')
    ) return;
    this.resizeRequested = true;
    this.scrollAfterFit ||= scrollToBottom;
    this.scheduleFit();
  }

  focus(): void {
    if (!this.disposed && !this.blocked) void this.surface.setFocused(true);
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
    if (this.resizeFrame !== null) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = null;
    this.unsubscribeBlocker();
    window.removeEventListener('soloe:rail-layout', this.onRailLayout);
    window.removeEventListener('soloe:renderer-zoom', this.onRendererZoom);
    void this.surface.dispose();
  }

  private scheduleFit(): void {
    if (this.resizeFrame !== null || this.resizeInFlight || this.disposed) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      this.runFit();
    });
  }

  private runFit(): void {
    if (
      !this.resizeRequested
      || this.disposed
      || !this.visible
      || this.blocked
      || !this.request.host.isConnected
    ) return;
    const bounds = this.request.host.getBoundingClientRect();
    if (bounds.width < 4 || bounds.height < 4) return;
    this.resizeRequested = false;
    const scrollToBottom = this.scrollAfterFit;
    this.scrollAfterFit = false;
    this.resizeInFlight = true;
    void this.surface.setBounds(bounds).then((size) => {
      if (size && !this.disposed) this.request.callbacks.onResize(size);
      if (scrollToBottom && !this.disposed) void this.surface.scrollToBottom();
    }).finally(() => {
      this.resizeInFlight = false;
      if (this.resizeRequested) this.scheduleFit();
    });
  }

  private syncSurfaceVisibility(): void {
    const nextVisible = this.visible && !this.blocked;
    if (nextVisible === this.surfaceVisible) return;
    this.surfaceVisible = nextVisible;
    if (!nextVisible) {
      void this.surface.setFocused(false);
      void this.surface.setVisible(false);
      return;
    }
    void this.surface.setVisible(true).then(() => {
      if (this.disposed || this.blocked || !this.visible) return;
      void this.surface.setFocused(this.focused);
      this.fit();
    });
  }

  private readonly onSurfaceBlocked = (blocked: boolean): void => {
    if (this.disposed || this.blocked === blocked) return;
    this.blocked = blocked;
    this.syncSurfaceVisibility();
  };

  private readonly onRendererZoom = (): void => {
    this.fit();
  };

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
