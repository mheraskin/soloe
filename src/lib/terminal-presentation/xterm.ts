import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { CanvasAddon } from '@xterm/addon-canvas';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import './xterm.css';
import { deferTerminalDispose, TerminalFitController } from '../terminal-fit';
import type {
  TerminalPresentation,
  TerminalPresentationConfiguration,
  TerminalPresentationCreateRequest
} from './types';

type XtermRenderer = WebglAddon | CanvasAddon;

/** Production Terminal Presentation Adapter for every renderer shell. */
export class XtermTerminalPresentationAdapter implements TerminalPresentation {
  readonly kind = 'xterm' as const;

  private readonly terminal: Terminal;
  private readonly fitAddon = new FitAddon();
  private readonly unicodeAddon = new Unicode11Addon();
  private readonly clipboardAddon = new ClipboardAddon();
  private readonly fitController = new TerminalFitController();
  private searchAddon: SearchAddon | null = null;
  private searchLoading: Promise<SearchAddon | null> | null = null;
  private renderer: XtermRenderer | null = null;
  private rendererLoadToken = 0;
  private resizeObserver: ResizeObserver | null = null;
  private visibleCleanup: (() => void) | null = null;
  private visible: boolean;
  private focused: boolean;
  private compactViewport: boolean;
  private disposed = false;
  private configuration: TerminalPresentationConfiguration;

  constructor(private readonly request: TerminalPresentationCreateRequest) {
    this.visible = request.visible;
    this.focused = request.focused;
    this.compactViewport = request.compactViewport;
    this.configuration = request.configuration;
    this.terminal = new Terminal(this.options(request.configuration));
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(
      new WebLinksAddon((_event, uri) => request.callbacks.onLink(uri))
    );
    this.terminal.loadAddon(this.unicodeAddon);
    this.terminal.loadAddon(this.clipboardAddon);
    this.terminal.unicode.activeVersion = request.configuration.unicodeVersion;
    this.terminal.attachCustomKeyEventHandler((event) => request.callbacks.onKey(event));
    this.terminal.onData((data) => request.callbacks.onInput(data));
    this.terminal.onSelectionChange(() => {
      request.callbacks.onSelectionChange?.(this.terminal.getSelection());
    });
    this.terminal.open(request.host);

    if (this.visible) this.attachVisibleResources();
    if (this.focused) this.setFocused(true, true);
  }

  write(data: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      try {
        this.terminal.write(data, resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  async replace(data: string): Promise<void> {
    if (this.disposed) return;
    this.terminal.reset();
    await this.write(data);
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      this.attachVisibleResources();
    } else {
      this.detachVisibleResources();
    }
  }

  setFocused(focused: boolean, autofocus: boolean): void {
    if (this.disposed) return;
    this.focused = focused;
    if (focused && autofocus) {
      requestAnimationFrame(() => {
        if (!this.disposed && this.focused) this.terminal.focus();
      });
    }
  }

  setCompactViewport(compact: boolean): void {
    this.compactViewport = compact;
  }

  setConfiguration(configuration: TerminalPresentationConfiguration): void {
    if (this.disposed) return;
    this.configuration = configuration;
    this.terminal.options.fontFamily = configuration.fontFamily;
    this.terminal.options.fontSize = configuration.fontSize;
    this.terminal.options.fontWeight = configuration.fontWeight;
    this.terminal.options.fontWeightBold = configuration.fontWeightBold;
    this.terminal.options.lineHeight = configuration.lineHeight;
    this.terminal.options.letterSpacing = configuration.letterSpacing;
    this.terminal.options.minimumContrastRatio = configuration.minimumContrastRatio;
    this.terminal.options.cursorStyle = configuration.cursorStyle;
    this.terminal.options.cursorWidth = configuration.cursorWidth;
    this.terminal.options.cursorInactiveStyle = configuration.cursorInactiveStyle;
    this.terminal.options.scrollback = configuration.scrollback;
    this.terminal.options.theme = configuration.theme;
    if (this.visible) this.loadFontsAndRepaint();
    this.fit();
  }

  fit(scrollToBottom = false): void {
    if (!this.canFit() || this.mobileKeyboardOpen()) return;
    this.fitController.scheduleFit(
      this.terminal,
      this.fitAddon,
      () => this.canFit(),
      (size) => {
        this.request.callbacks.onResize(size);
        if (scrollToBottom) this.terminal.scrollToBottom();
      },
      (error) => this.rendererFailure('canvas', error, true)
    );
  }

  focus(): void {
    if (!this.disposed) this.terminal.focus();
  }

  paste(text: string): void {
    if (!this.disposed) this.terminal.paste(text);
  }

  hasSelection(): boolean {
    return !this.disposed && this.terminal.hasSelection();
  }

  getSelection(): string {
    return this.disposed ? '' : this.terminal.getSelection();
  }

  clearSelection(): void {
    if (!this.disposed) this.terminal.clearSelection();
  }

  async find(query: string, direction: 'next' | 'previous'): Promise<boolean> {
    if (!query || this.disposed) return false;
    const search = await this.ensureSearchAddon();
    if (!search || this.disposed) return false;
    return direction === 'next' ? search.findNext(query) : search.findPrevious(query);
  }

  exportBuffer(): Promise<string> {
    if (this.disposed) return Promise.resolve('');
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }
    return Promise.resolve(`${lines.join('\n').replace(/\s+$/u, '')}\n`);
  }

  scrollToBottom(): void {
    if (!this.disposed) this.terminal.scrollToBottom();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachVisibleResources();
    this.fitController.cancel();
    this.clipboardAddon.dispose();
    this.unicodeAddon.dispose();
    this.searchAddon = null;
    this.searchLoading = null;
    // xterm 5.5 leaves an initialization viewport timer queued during open.
    deferTerminalDispose(this.terminal);
  }

  private options(configuration: TerminalPresentationConfiguration) {
    return {
      fontFamily: configuration.fontFamily,
      fontSize: configuration.fontSize,
      fontWeight: configuration.fontWeight,
      fontWeightBold: configuration.fontWeightBold,
      lineHeight: configuration.lineHeight,
      letterSpacing: configuration.letterSpacing,
      minimumContrastRatio: configuration.minimumContrastRatio,
      drawBoldTextInBrightColors: false,
      rescaleOverlappingGlyphs: false,
      cursorStyle: configuration.cursorStyle,
      cursorWidth: configuration.cursorWidth,
      cursorInactiveStyle: configuration.cursorInactiveStyle,
      cursorBlink: false,
      theme: configuration.theme,
      allowProposedApi: true,
      scrollback: configuration.scrollback,
      convertEol: false
    } as const;
  }

  private attachVisibleResources(): void {
    if (this.disposed || this.visibleCleanup) return;
    this.terminal.options.cursorBlink = true;
    void this.attachRenderer();
    this.loadFontsAndRepaint();
    document.fonts.addEventListener('loadingdone', this.repaintFontAtlas);
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !this.visible || this.mobileKeyboardOpen()) return;
      if (entry.contentRect.width < 4 || entry.contentRect.height < 4) return;
      this.fit();
    });
    this.resizeObserver.observe(this.request.host);
    const onRailLayout = (event: Event) => {
      const detail = (event as CustomEvent<{
        keyboardOpen?: boolean;
        keyboardClosed?: boolean;
      }>).detail;
      if (detail?.keyboardOpen) {
        this.terminal.scrollToBottom();
      } else if (detail?.keyboardClosed) {
        requestAnimationFrame(() => requestAnimationFrame(() => this.fit(true)));
      } else {
        this.fit();
      }
    };
    window.addEventListener('soloe:rail-layout', onRailLayout);
    this.visibleCleanup = () => {
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      window.removeEventListener('soloe:rail-layout', onRailLayout);
      document.fonts.removeEventListener('loadingdone', this.repaintFontAtlas);
    };
    this.terminal.refresh(0, this.terminal.rows - 1);
    this.fitInitial();
  }

  private detachVisibleResources(): void {
    this.visibleCleanup?.();
    this.visibleCleanup = null;
    this.fitController.cancel();
    try {
      this.terminal.options.cursorBlink = false;
    } catch {
      // The terminal can already be disposed during component teardown.
    }
    this.detachRenderer();
  }

  private fitInitial(): void {
    requestAnimationFrame(() => {
      if (!this.canFit()) return;
      try {
        const size = this.fitController.fit(
          this.terminal,
          this.fitAddon,
          () => this.canFit()
        );
        this.request.callbacks.onResize(size);
      } catch (error) {
        this.rendererFailure('canvas', error, true);
      }
    });
  }

  private canFit(): boolean {
    if (this.disposed || !this.visible || !this.request.host.isConnected) return false;
    const rect = this.request.host.getBoundingClientRect();
    return rect.width >= 4 && rect.height >= 4;
  }

  private mobileKeyboardOpen(): boolean {
    return this.compactViewport
      && document.documentElement.hasAttribute('data-mobile-keyboard-open');
  }

  private async ensureSearchAddon(): Promise<SearchAddon | null> {
    if (this.searchAddon) return this.searchAddon;
    if (this.searchLoading) return this.searchLoading;
    this.searchLoading = import('@xterm/addon-search')
      .then(({ SearchAddon }) => {
        if (this.disposed) return null;
        const addon = new SearchAddon();
        this.terminal.loadAddon(addon);
        this.searchAddon = addon;
        return addon;
      })
      .catch(() => null)
      .finally(() => {
        this.searchLoading = null;
      });
    return this.searchLoading;
  }

  private async attachRenderer(): Promise<void> {
    if (this.renderer || this.disposed || !this.visible) return;
    const token = ++this.rendererLoadToken;
    let webgl: WebglAddon | null = null;
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl');
      if (!this.rendererCanAttach(token)) return;
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        if (this.renderer !== webgl) return;
        this.renderer = null;
        webgl?.dispose();
        this.rendererFailure('webgl', new Error('WebGL context lost'), true);
        const fallbackToken = ++this.rendererLoadToken;
        if (!this.disposed && this.visible) void this.attachCanvasRenderer(fallbackToken);
      });
      this.terminal.loadAddon(webgl);
      this.renderer = webgl;
      this.terminal.refresh(0, this.terminal.rows - 1);
      return;
    } catch (error) {
      webgl?.dispose();
      this.rendererFailure('webgl', error, true);
    }
    if (this.rendererCanAttach(token)) await this.attachCanvasRenderer(token);
  }

  private async attachCanvasRenderer(token: number): Promise<void> {
    let canvas: CanvasAddon | null = null;
    try {
      const { CanvasAddon } = await import('@xterm/addon-canvas');
      if (!this.rendererCanAttach(token)) return;
      canvas = new CanvasAddon();
      this.terminal.loadAddon(canvas);
      this.renderer = canvas;
      this.terminal.refresh(0, this.terminal.rows - 1);
    } catch (error) {
      canvas?.dispose();
      this.rendererFailure('canvas', error, true);
    }
  }

  private rendererCanAttach(token: number): boolean {
    return token === this.rendererLoadToken && !this.disposed && this.visible;
  }

  private detachRenderer(): void {
    this.rendererLoadToken += 1;
    const renderer = this.renderer;
    this.renderer = null;
    renderer?.dispose();
  }

  private loadFontsAndRepaint(): void {
    if (!this.visible || this.disposed) return;
    const { fontSize } = this.configuration;
    void Promise.all([
      document.fonts.load(`400 ${fontSize}px "JetBrains Mono"`),
      document.fonts.load(`700 ${fontSize}px "JetBrains Mono"`),
      document.fonts.load(`400 ${fontSize}px "Cascadia Code"`, '─'),
      document.fonts.load(`700 ${fontSize}px "Cascadia Code"`, '─')
    ]).then(this.repaintFontAtlas).catch(() => {});
  }

  private readonly repaintFontAtlas = (): void => {
    if (!this.visible || this.disposed) return;
    if (this.renderer && 'clearTextureAtlas' in this.renderer) {
      this.renderer.clearTextureAtlas();
    }
    requestAnimationFrame(() => {
      if (!this.visible || this.disposed) return;
      if (this.renderer && 'clearTextureAtlas' in this.renderer) {
        this.renderer.clearTextureAtlas();
      }
      this.terminal.refresh(0, this.terminal.rows - 1);
    });
  };

  private rendererFailure(
    renderer: 'webgl' | 'canvas',
    error: unknown,
    recovered: boolean
  ): void {
    this.request.callbacks.onRendererFailure?.({ renderer, error, recovered });
  }
}
