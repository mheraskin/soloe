<script lang="ts">
  import { untrack } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import type { SearchAddon } from '@xterm/addon-search';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import type { WebglAddon } from '@xterm/addon-webgl';
  import type { CanvasAddon } from '@xterm/addon-canvas';
  import { Unicode11Addon } from '@xterm/addon-unicode11';
  import { ClipboardAddon } from '@xterm/addon-clipboard';
  import '@xterm/xterm/css/xterm.css';
  import { ipc } from '../lib/ipc';
  import type { TerminalPresentation } from '../lib/terminal-output-router';
  import type { TerminalId } from '@shared/types/terminal.js';
  import type { SessionId } from '@shared/types/sessions.js';
  import { effectiveAgentProvider, launchKind } from '@shared/types/sessions.js';
  import { settings } from '../stores/settings.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { nav } from '../stores/nav.svelte';
  import { rightRail } from '../stores/right-rail.svelte';
  import { sidebar } from '../stores/sidebar.svelte';
  import { reportError, toasts } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as ContextMenu from '$lib/components/ui/context-menu';
  import { Copy, Loader2, MessageSquarePlus, Send, X } from '@lucide/svelte';
  import AskAgentPopover from './ask-agent/AskAgentPopover.svelte';
  import { Keymap, tabIndexFromEvent, worktreeIndexFromEvent } from '../lib/keymap';
  import { toggleRailTabAndFocus } from '../lib/rail-focus';
  import {
    AGENT_IMAGE_PASTE_SEQUENCE,
    isClipboardPasteShortcut,
    SHIFT_ENTER_SEQUENCE,
    shouldPasteImageViaSavedPath,
    shouldSendShiftEnterSequence
  } from '../lib/terminal-input';
  import { deferTerminalDispose, TerminalFitController } from '../lib/terminal-fit';
  import type { ClipboardImagePayload } from '@shared/types/files.js';

  // `visible` drives layout work (fit/resize/atlas) and runs for both panes of
  // a split simultaneously; `focused` drives keyboard concerns (xterm focus,
  // find bar, buffer copy) and is true for only one pane at a time.
  let {
    terminalId,
    sessionId,
    visible,
    focused
  }: {
    terminalId: TerminalId;
    sessionId: SessionId;
    visible: boolean;
    focused: boolean;
  } = $props();

  let fontSize = $derived(settings.current.terminal.fontSize);

  let host: HTMLDivElement | undefined = $state();
  let findInput: HTMLInputElement | null = $state(null);
  let findOpen = $state(false);
  let findQuery = $state('');
  let ready = $state(false);
  let loadingLabel = $derived(
    sessions.runtime[sessionId]?.status === 'starting' ? 'Starting' : 'Restoring terminal'
  );
  // Floating "Ask Agent" chip state. We snapshot the selected text into
  // `chipText` at mouseup time and keep the chip visible from that snapshot
  // — not from `term.hasSelection()`. Claude's TUI mode redraws the screen
  // every frame, which makes xterm drop its native selection almost
  // immediately; reading the live selection would hide the chip before the
  // user can click it. The chip is dismissed on: new mousedown in the
  // terminal, click outside the terminal+chip, Escape, or after the
  // popover handles it.
  let chipText = $state<string>('');
  let chipAnchor = $state<{ top: number; left: number } | null>(null);
  let chipEl: HTMLButtonElement | null = $state(null);
  let askOpen = $state(false);
  let askSelection = $state<string>('');
  // Context menu enabled-state mirror. Re-read when the menu opens.
  let menuHasSelection = $state(false);
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let search: SearchAddon | null = null;
  let searchLoading: Promise<SearchAddon | null> | null = null;
  let renderer: WebglAddon | CanvasAddon | null = null;
  let outputPresentation: TerminalPresentation | null = null;
  let rendererLoadToken = 0;
  const terminalFit = new TerminalFitController();
  // Hide the loading overlay only once output has actually settled — the first
  // byte alone is too early (shells stream a banner before the prompt; agents
  // paint a TUI in stages). We wait for a quiet window after first output, with
  // a cap so a perpetually-animated TUI can never get stuck behind the overlay.
  const READY_QUIET_MS = 300;
  const READY_HARD_CAP_MS = 5000;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;

  function clearReadyTimers(): void {
    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (capTimer) {
      clearTimeout(capTimer);
      capTimer = null;
    }
  }

  function markReady(): void {
    ready = true;
    clearReadyTimers();
  }

  function noteOutput(byteCount: number): void {
    if (ready || byteCount === 0) return;
    if (capTimer === null) {
      capTimer = setTimeout(markReady, READY_HARD_CAP_MS);
    }
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(markReady, READY_QUIET_MS);
  }

  function bufferText(): string {
    if (!term) return '';
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i += 1) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\n').replace(/\s+$/u, '') + '\n';
  }

  async function openFind(): Promise<void> {
    if (!focused) return;
    await ensureSearchAddon();
    if (!focused) return;
    findOpen = true;
    requestAnimationFrame(() => findInput?.focus());
  }

  async function ensureSearchAddon(): Promise<SearchAddon | null> {
    if (search) return search;
    if (searchLoading) return searchLoading;
    const current = term;
    if (!current) return null;
    searchLoading = import('@xterm/addon-search')
      .then(({ SearchAddon }) => {
        if (term !== current) return null;
        const addon = new SearchAddon();
        current.loadAddon(addon);
        search = addon;
        return addon;
      })
      .catch(() => null)
      .finally(() => {
        searchLoading = null;
      });
    return searchLoading;
  }

  async function saveBuffer(): Promise<void> {
    if (!focused) return;
    await ipc.system.saveText({
      defaultPath: `${terminalId}.log`,
      content: bufferText()
    });
  }

  async function copyBuffer(): Promise<void> {
    if (!focused) return;
    await navigator.clipboard.writeText(bufferText());
    toasts.push('Copied terminal buffer', 'info');
  }

  async function copyMarkdown(): Promise<void> {
    if (!focused) return;
    const session = sessions.sessions.find((item) => item.id === sessionId);
    const header = session
      ? `# ${session.name || session.id}\n\n- cwd: ${session.cwd}\n- launch: ${launchKind(session)}\n- run mode: ${session.runMode}\n\n`
      : `# ${sessionId}\n\n`;
    await navigator.clipboard.writeText(`${header}\`\`\`text\n${bufferText()}\`\`\`\n`);
    toasts.push('Copied session as Markdown', 'info');
  }

  function onFindInput(): void {
    if (!findQuery) return;
    search?.findNext(findQuery);
  }

  async function clipboardImages(): Promise<ClipboardImagePayload[]> {
    if (!navigator.clipboard?.read) return [];
    const items = await navigator.clipboard.read();
    const images: ClipboardImagePayload[] = [];
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'));
      if (!imageType) continue;
      const blob = await item.getType(imageType);
      images.push({
        mimeType: imageType,
        dataBase64: await blobToBase64(blob)
      });
    }
    return images;
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read clipboard image'));
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        resolve(result.replace(/^data:[^,]*,/u, ''));
      };
      reader.readAsDataURL(blob);
    });
  }

  function clearChip(): void {
    chipText = '';
    chipAnchor = null;
  }

  // Anchor the floating chip near the user's last mouseup so it doesn't
  // sit at a random fixed corner. xterm renders the selection via WebGL,
  // so we can't query window.getSelection — fall back to the pointer.
  function anchorChipAtPointer(clientX: number, clientY: number): void {
    const buttonW = 112;
    const buttonH = 28;
    const margin = 8;
    let top = clientY + 12;
    let left = clientX - buttonW;
    if (top + buttonH + margin > window.innerHeight) {
      top = clientY - buttonH - 12;
    }
    if (left < margin) left = margin;
    if (left + buttonW + margin > window.innerWidth) {
      left = window.innerWidth - buttonW - margin;
    }
    chipAnchor = { top, left };
  }

  function openAskFromChip(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (!chipText) return;
    askSelection = chipText;
    askOpen = true;
  }

  function onAskOpenChange(next: boolean): void {
    askOpen = next;
    if (!next) {
      askSelection = '';
      // Re-focus the terminal so the user can keep typing.
      term?.focus();
    }
  }

  function onMenuOpenChange(open: boolean): void {
    if (!open) return;
    menuHasSelection = !!term && term.hasSelection();
  }

  function ctxAskAgent(): void {
    const t = term;
    if (!t || !t.hasSelection()) return;
    askSelection = t.getSelection();
    askOpen = true;
  }

  async function ctxCopy(): Promise<void> {
    const t = term;
    if (!t || !t.hasSelection()) return;
    try {
      await navigator.clipboard.writeText(t.getSelection());
      t.clearSelection();
    } catch (err) {
      reportError(err);
    }
  }

  async function pasteFromClipboard(t: Terminal): Promise<void> {
    const session = sessions.sessions.find((item) => item.id === sessionId);
    if (session && effectiveAgentProvider(session)) {
      const images = await clipboardImages().catch(() => []);
      if (images.length > 0) {
        if (shouldPasteImageViaSavedPath(session)) {
          await ipc.files.pasteImagesIntoTerminal({
            terminalId,
            sessionId,
            images
          });
          return;
        }
        await ipc.terminal.input(terminalId, AGENT_IMAGE_PASTE_SEQUENCE);
        return;
      }
    }

    const text = await navigator.clipboard.readText().catch(() => '');
    if (!text) return;
    t.paste(text);
  }

  // Always write straight to xterm; the renderer is a separate concern and
  // is harmlessly a no-op when the canvas is offscreen or 0×0. Buffering
  // output ourselves used to create a stale-frame class of bugs when the
  // host was hidden via display:none (rail fullscreen) without `active`
  // flipping, because nothing flushed the backlog on un-hide.
  function writeOutput(data: string): Promise<void> {
    const current = term;
    if (!current) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        current.write(data, resolve);
        noteOutput(data.length);
      } catch (err) {
        console.warn('[DEBUG-xterm] write failed', { terminalId, sessionId, err });
        resolve();
      }
    });
  }

  function replaceOutput(data: string): Promise<void> {
    const current = term;
    if (!current) return Promise.resolve();
    current.reset();
    return writeOutput(data);
  }

  // A WebGL context is scarce — Chromium force-loses the oldest once a page
  // holds roughly 16 — and losing one silently drops that terminal to xterm's
  // DOM renderer, which cannot keep up with an agent TUI. Presentations may
  // remain resident briefly after a Session is hidden, so binding a context to
  // every pane would eventually starve the visible one. Only panes the user can
  // see hold a renderer; hidden panes have nothing to draw.
  async function attachCanvasRenderer(t: Terminal, token: number): Promise<void> {
    let canvas: CanvasAddon | null = null;
    try {
      const { CanvasAddon } = await import('@xterm/addon-canvas');
      if (token !== rendererLoadToken || term !== t || !visible) return;
      canvas = new CanvasAddon();
      t.loadAddon(canvas);
      renderer = canvas;
      t.refresh(0, t.rows - 1);
    } catch (err) {
      canvas?.dispose();
      console.warn('[DEBUG-xterm] Canvas renderer unavailable, using DOM', {
        terminalId,
        sessionId,
        err
      });
    }
  }

  async function attachRenderer(t: Terminal): Promise<void> {
    if (renderer) return;
    const token = ++rendererLoadToken;
    let webgl: WebglAddon | null = null;
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl');
      if (token !== rendererLoadToken || term !== t || !visible) return;
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        if (renderer !== webgl) return;
        renderer = null;
        webgl?.dispose();
        const fallbackToken = ++rendererLoadToken;
        if (term === t && visible) void attachCanvasRenderer(t, fallbackToken);
      });
      t.loadAddon(webgl);
      renderer = webgl;
      t.refresh(0, t.rows - 1);
      return;
    } catch (err) {
      webgl?.dispose();
      console.warn('[DEBUG-xterm] WebGL renderer unavailable, falling back to canvas', {
        terminalId,
        sessionId,
        err
      });
    }
    if (token === rendererLoadToken && term === t && visible) {
      await attachCanvasRenderer(t, token);
    }
  }

  function detachRenderer(): void {
    rendererLoadToken += 1;
    const current = renderer;
    renderer = null;
    current?.dispose();
  }

  function repaintFontAtlas(): void {
    const current = term;
    if (!visible || !current) return;
    if (renderer && 'clearTextureAtlas' in renderer) {
      renderer.clearTextureAtlas();
    }
    requestAnimationFrame(() => {
      if (!visible || term !== current) return;
      if (renderer && 'clearTextureAtlas' in renderer) {
        renderer.clearTextureAtlas();
      }
      current.refresh(0, current.rows - 1);
    });
  }

  $effect(() => {
    if (!host) return;
    const initFontSize = untrack(() => fontSize);
    const t = new Terminal({
      fontFamily: 'JetBrains Mono, Cascadia Code, ui-monospace, monospace',
      fontSize: initFontSize,
      fontWeight: 400,
      fontWeightBold: 700,
      // Integer lineHeight: non-integer values produce per-DPR-rounded row
      // heights that shift by a pixel between frames, which flickers on
      // rapidly redrawn rows under WebGL.
      lineHeight: 1.0,
      letterSpacing: 0,
      // Lifts low-contrast ANSI colors (e.g. dim blue on black) to WCAG AA.
      minimumContrastRatio: 4.5,
      drawBoldTextInBrightColors: false,
      // Off: rescales adjacent glyph widths every frame, which makes cells
      // breathe by ~1px during animation/typing on top of WebGL flicker.
      rescaleOverlappingGlyphs: false,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'outline',
      // Activated only while visible; hidden panes otherwise retain one cursor
      // timer each even though they have no renderer.
      cursorBlink: false,
      // Tokyo Night palette tuned to the #0f0f10 app shell.
      theme: {
        background: '#0f0f10',
        foreground: '#e6e6e6',
        cursor: '#e6e6e6',
        cursorAccent: '#0f0f10',
        selectionBackground: '#283457',
        selectionForeground: '#e6e6e6',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#ff899d',
        brightGreen: '#9fe044',
        brightYellow: '#faba4a',
        brightBlue: '#8db0ff',
        brightMagenta: '#c7a9ff',
        brightCyan: '#a4daff',
        brightWhite: '#e6e6e6'
      },
      allowProposedApi: true,
      scrollback: 5000,
      convertEol: false
    });
    const f = new FitAddon();
    const links = new WebLinksAddon((_event, uri) => {
      void ipc.system.openExternal(uri).catch(reportError);
    });
    const unicode11 = new Unicode11Addon();
    const clipboard = new ClipboardAddon();
    t.loadAddon(f);
    t.loadAddon(links);
    t.loadAddon(unicode11);
    t.loadAddon(clipboard);
    t.unicode.activeVersion = '11';
    t.open(host);

    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      if (tabIndexFromEvent(e) !== null) return false;
      if (worktreeIndexFromEvent(e) !== null) return false;
      if (Keymap.deleteSelectedSession.match(e)) {
        e.preventDefault();
        void nav.closeActive();
        return false;
      }
      if (Keymap.toggleNotesRail.match(e)) {
        e.preventDefault();
        void toggleRailTabAndFocus('notes');
        return false;
      }
      if (Keymap.toggleDiffRail.match(e)) {
        e.preventDefault();
        void toggleRailTabAndFocus('diff');
        return false;
      }
      if (Keymap.toggleFilesRail.match(e)) {
        e.preventDefault();
        void toggleRailTabAndFocus('files');
        return false;
      }
      if (Keymap.toggleFeatureRail.match(e)) {
        e.preventDefault();
        void toggleRailTabAndFocus('feature');
        return false;
      }
      if (Keymap.toggleBrowserRail.match(e)) {
        e.preventDefault();
        void toggleRailTabAndFocus('browser');
        return false;
      }
      if (Keymap.toggleSidebar.match(e)) {
        e.preventDefault();
        sidebar.toggle();
        return false;
      }
      for (const binding of Object.values(Keymap)) {
        if (binding.id === Keymap.deleteSelectedSession.id) continue;
        if (binding.id === Keymap.toggleNotesRail.id) continue;
        if (binding.id === Keymap.toggleDiffRail.id) continue;
        if (binding.id === Keymap.toggleFilesRail.id) continue;
        if (binding.id === Keymap.toggleFeatureRail.id) continue;
        if (binding.id === Keymap.toggleBrowserRail.id) continue;
        if (binding.id === Keymap.toggleSidebar.id) continue;
        if (binding.match(e)) return false;
      }

      if (isClipboardPasteShortcut(e)) {
        e.preventDefault();
        void pasteFromClipboard(t).catch(reportError);
        return false;
      }
      if (shouldSendShiftEnterSequence(e)) {
        e.preventDefault();
        void ipc.terminal.input(terminalId, SHIFT_ENTER_SEQUENCE).catch(() => {});
        return false;
      }

      const ctrlOrCmd = (e.ctrlKey || e.metaKey) && !e.altKey;
      if (ctrlOrCmd && e.key.toLowerCase() === 'c') {
        if (!e.shiftKey) {
          if (!t.hasSelection()) return true;
          void navigator.clipboard.writeText(t.getSelection()).catch(() => {});
          t.clearSelection();
          return false;
        }
        if (t.hasSelection()) {
          void navigator.clipboard.writeText(t.getSelection()).catch(() => {});
          t.clearSelection();
        }
        return false;
      }

      return true;
    });

    requestAnimationFrame(() => {
      if (!visible) return;
      try {
        terminalFit.fit(t, f, () => visible && term === t && fit === f);
        // Sync PTY immediately so the first output isn't wrapped at the
        // default 80x24 and replayed at the actual geometry.
        if (Number.isFinite(t.cols) && Number.isFinite(t.rows)) {
          void ipc.terminal.resize(terminalId, t.cols, t.rows).catch(() => {});
        }
      } catch (err) {
        console.warn('[DEBUG-xterm] initial fit failed', { terminalId, sessionId, err });
      }
    });
    term = t;
    fit = f;

    const presentation = ipc.terminal.attachPresentation(
      terminalId,
      sessionId,
      { write: writeOutput, replace: replaceOutput },
      untrack(() => visible)
    );
    outputPresentation = presentation;

    const onInput = t.onData((data) => {
      void ipc.terminal.input(terminalId, data).catch(() => {
        // silent — terminal probably exited
      });
    });

    // Selection chip lifecycle: snapshot the selected text into `chipText`
    // on mouseup so the chip survives Claude TUI's screen redraws, which
    // otherwise wipe xterm's native selection before the user can click.
    // The chip is dismissed by:
    //  - a new mousedown in the terminal (starts a fresh drag)
    //  - a mousedown outside the terminal (also clears xterm's highlight)
    //  - Escape
    //  - opening the popover (which takes the captured text)
    const onHostMouseUp = (e: MouseEvent) => {
      // Defer one frame so xterm has committed the selection by the time we
      // read it (selection commits async after the drag-end).
      requestAnimationFrame(() => {
        const t2 = term;
        if (!t2) return;
        const text = t2.getSelection();
        if (!text) return; // empty drag — leave any existing chip alone
        chipText = text;
        anchorChipAtPointer(e.clientX, e.clientY);
      });
    };
    const onHostMouseDown = () => {
      if (askOpen) return;
      clearChip();
    };
    host?.addEventListener('mouseup', onHostMouseUp);
    host?.addEventListener('mousedown', onHostMouseDown);

    return () => {
      host?.removeEventListener('mouseup', onHostMouseUp);
      host?.removeEventListener('mousedown', onHostMouseDown);
      onInput.dispose();
      presentation.dispose();
      if (outputPresentation === presentation) outputPresentation = null;
      terminalFit.cancel();
      detachRenderer();
      clipboard.dispose();
      unicode11.dispose();
      term = null;
      fit = null;
      search = null;
      searchLoading = null;
      renderer = null;
      clearReadyTimers();
      // xterm 5.5 queues Viewport.syncScrollArea during open without clearing
      // that timer on dispose. Let the queued initialization finish before
      // releasing the renderer (fixed upstream in xtermjs/xterm.js#4984).
      deferTerminalDispose(t);
    };
  });

  // Terminal construction is intentionally independent of visibility. Hidden
  // resident presentations stop parsing output; reveal catches up from the
  // last sequence xterm applied through the bounded Terminal Replay Tail.
  $effect(() => {
    const nextVisible = visible;
    untrack(() => outputPresentation?.setVisible(nextVisible));
  });

  // Only the focused pane owns app-wide terminal commands and document input
  // listeners. Previously every running pane handled every click and keydown,
  // even when translated offscreen.
  $effect(() => {
    if (!focused || !term) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (askOpen) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (host && host.contains(target)) return;
      if (chipEl && chipEl.contains(target)) return;
      clearChip();
      term?.clearSelection();
    };
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || askOpen || !chipText) return;
      clearChip();
      term?.clearSelection();
    };
    const onFind = () => { void openFind(); };
    const onSave = () => { void saveBuffer().catch(reportError); };
    const onCopy = () => { void copyBuffer().catch(reportError); };
    const onCopyMarkdown = () => { void copyMarkdown().catch(reportError); };
    const onRefocus = () => term?.focus();

    window.addEventListener('mousedown', onDocMouseDown, true);
    window.addEventListener('keydown', onDocKeyDown);
    window.addEventListener('soloe:terminal-find', onFind);
    window.addEventListener('soloe:terminal-save-buffer', onSave);
    window.addEventListener('soloe:terminal-copy-buffer', onCopy);
    window.addEventListener('soloe:terminal-copy-markdown', onCopyMarkdown);
    window.addEventListener('soloe:refocus-terminal', onRefocus);
    return () => {
      window.removeEventListener('mousedown', onDocMouseDown, true);
      window.removeEventListener('keydown', onDocKeyDown);
      window.removeEventListener('soloe:terminal-find', onFind);
      window.removeEventListener('soloe:terminal-save-buffer', onSave);
      window.removeEventListener('soloe:terminal-copy-buffer', onCopy);
      window.removeEventListener('soloe:terminal-copy-markdown', onCopyMarkdown);
      window.removeEventListener('soloe:refocus-terminal', onRefocus);
    };
  });

  $effect(() => {
    if (!visible || !term || !fit || !host) return;
    const currentTerm = term;
    const currentFit = fit;
    const currentHost = host;
    term.options.fontSize = fontSize;
    // Font subsets and atlas repair are needed only for panes that can draw.
    // Browser font loads are cached, but avoiding four requests per hidden
    // terminal also avoids a Promise/listener fan-out during session restore.
    void Promise.all([
      document.fonts.load(`400 ${fontSize}px "JetBrains Mono"`),
      document.fonts.load(`700 ${fontSize}px "JetBrains Mono"`),
      document.fonts.load(`400 ${fontSize}px "Cascadia Code"`, '─'),
      document.fonts.load(`700 ${fontSize}px "Cascadia Code"`, '─')
    ]).then(repaintFontAtlas).catch(() => {});
    requestAnimationFrame(() => {
      if (!visible || term !== currentTerm || fit !== currentFit || host !== currentHost) return;
      const rect = currentHost.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      try {
        terminalFit.fit(
          currentTerm,
          currentFit,
          () =>
            visible &&
            term === currentTerm &&
            fit === currentFit &&
            host === currentHost &&
            currentHost.isConnected
        );
        void ipc.terminal.resize(terminalId, currentTerm.cols, currentTerm.rows).catch(() => {});
      } catch (err) {
        console.warn('[DEBUG-xterm] font-size fit failed', { terminalId, sessionId, err });
      }
    });
  });

  // Owns the renderer for as long as this pane is on screen, then refits and
  // evicts the glyph atlas. While hidden the terminal holds no GPU context and
  // its atlas goes stale (lazy font subsets load after it last painted), so a
  // reveal has to re-rasterise from scratch. This runs for both halves of a
  // split, so it deliberately does not touch focus — that is the focused
  // effect's job.
  $effect(() => {
    if (!visible || !term || !fit || !host) return;
    const currentTerm = term;
    const currentFit = fit;
    const currentHost = host;
    currentTerm.options.cursorBlink = true;
    void attachRenderer(currentTerm);
    document.fonts.addEventListener('loadingdone', repaintFontAtlas);
    repaintFontAtlas();
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !visible || term !== currentTerm) return;
      const { width, height } = entry.contentRect;
      if (width < 4 || height < 4) return;
      try {
        terminalFit.fit(
          currentTerm,
          currentFit,
          () =>
            visible &&
            term === currentTerm &&
            fit === currentFit &&
            host === currentHost &&
            currentHost.isConnected
        );
        void ipc.terminal.resize(terminalId, currentTerm.cols, currentTerm.rows).catch(() => {});
      } catch (err) {
        console.warn('[DEBUG-xterm] resize observer fit failed', { terminalId, sessionId, err });
      }
    });
    ro.observe(currentHost);
    if (renderer && 'clearTextureAtlas' in renderer) {
      renderer.clearTextureAtlas();
    }
    currentTerm.refresh(0, currentTerm.rows - 1);
    requestAnimationFrame(() => {
      if (!visible || term !== currentTerm) return;
      const rect = currentHost.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      try {
        terminalFit.fit(
          currentTerm,
          currentFit,
          () =>
            visible &&
            term === currentTerm &&
            fit === currentFit &&
            host === currentHost &&
            currentHost.isConnected
        );
        void ipc.terminal.resize(terminalId, currentTerm.cols, currentTerm.rows).catch(() => {});
      } catch (err) {
        console.warn('[DEBUG-xterm] visible fit failed', { terminalId, sessionId, err });
      }
    });
    return () => {
      ro.disconnect();
      terminalFit.cancel();
      document.fonts.removeEventListener('loadingdone', repaintFontAtlas);
      try {
        currentTerm.options.cursorBlink = false;
      } catch {
        // Terminal may already be disposed during component teardown.
      }
      detachRenderer();
    };
  });

  // Only the focused pane takes keyboard focus. Deferring a frame lets the
  // visible effect's fit settle first when a pane becomes visible and focused
  // in the same tick.
  $effect(() => {
    if (!focused || !term) return;
    requestAnimationFrame(() => term?.focus());
  });
</script>

<div class="relative h-full w-full bg-[#0f0f10] p-2">
  {#if !ready}
    <div
      class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[#0f0f10]/75 backdrop-blur-sm transition-opacity duration-500 ease-out"
    >
      <div class="flex flex-col items-center gap-3">
        <span class="relative flex size-9 items-center justify-center">
          <span class="absolute inset-0 animate-ping rounded-full bg-foreground/5"></span>
          <span class="relative flex size-9 items-center justify-center rounded-full bg-background/50 ring-1 ring-border/40">
            <Loader2 class="size-4 animate-spin text-foreground/70" />
          </span>
        </span>
        <span class="text-[10px] font-medium tracking-[0.18em] text-muted-foreground/80 uppercase">
          {loadingLabel}
        </span>
      </div>
    </div>
  {/if}
  {#if findOpen && focused}
    <div class="absolute top-2.5 right-4 z-10 flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg">
      <Input
        bind:ref={findInput}
        bind:value={findQuery}
        oninput={onFindInput}
        onkeydown={(e) => {
          if (e.key === 'Escape') findOpen = false;
          if (e.key === 'Enter' && findQuery) search?.findNext(findQuery);
        }}
        placeholder="Find"
        aria-label="Find in terminal"
        class="h-7 w-44 text-xs"
      />
      <Button variant="ghost" size="xs" onclick={() => findQuery && search?.findPrevious(findQuery)}>Prev</Button>
      <Button variant="ghost" size="xs" onclick={() => findQuery && search?.findNext(findQuery)}>Next</Button>
      <Button variant="ghost" size="icon-xs" onclick={() => (findOpen = false)} aria-label="Close find">
        <X />
      </Button>
    </div>
  {/if}
  <ContextMenu.Root onOpenChange={onMenuOpenChange}>
    <ContextMenu.Trigger>
      {#snippet child({ props })}
        <div {...props} class="h-full w-full" bind:this={host}></div>
      {/snippet}
    </ContextMenu.Trigger>
    <ContextMenu.Content class="w-44">
      <ContextMenu.Item disabled={!menuHasSelection} onclick={ctxAskAgent}>
        <MessageSquarePlus class="size-3.5" />
        Ask Agent
      </ContextMenu.Item>
      <ContextMenu.Item disabled={!menuHasSelection} onclick={() => void ctxCopy()}>
        <Copy class="size-3.5" />
        Copy
      </ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Root>
</div>

{#if chipText || askOpen}
  <button
    bind:this={chipEl}
    type="button"
    class="fixed z-50 flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 font-sans text-[11px] text-popover-foreground shadow-md hover:bg-accent hover:text-accent-foreground"
    style:top="{chipAnchor?.top ?? 0}px"
    style:left="{chipAnchor?.left ?? 0}px"
    style:visibility={chipAnchor ? 'visible' : 'hidden'}
    onmousedown={openAskFromChip}
    aria-label="Ask Agent about selection"
    title="Ask Agent about selection"
  >
    <Send class="size-3.5" />
    <span>Ask Agent</span>
  </button>
{/if}

{#if askSelection.length > 0}
  <AskAgentPopover
    open={askOpen}
    onOpenChange={onAskOpenChange}
    selectionText={askSelection}
    anchorEl={chipEl}
    side="top"
    align="end"
  />
{/if}

<style>
  :global(.xterm) {
    background: #0f0f10 !important;
    height: 100%;
  }
  :global(.xterm-screen),
  :global(.xterm-viewport) {
    background: #0f0f10 !important;
  }
</style>
