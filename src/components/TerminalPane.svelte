<script lang="ts">
  import { onMount, untrack } from 'svelte';
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
  import { terminalControlProof, type TerminalId } from '@shared/types/terminal.js';
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
  import { Keymap, shiftNumberIndexFromEvent, tabIndexFromEvent } from '../lib/keymap';
  import { toggleRailTabAndFocus } from '../lib/rail-focus';
  import {
    ctrlSlashSequence,
    isClipboardPasteShortcut,
    SHIFT_ENTER_SEQUENCE,
    shouldSendShiftEnterSequence
  } from '../lib/terminal-input';
  import { deferTerminalDispose, TerminalFitController } from '../lib/terminal-fit';
  import { usesMacosOverlayScrollbars } from '../lib/platform-ui';
  import { readClipboardImages } from '../lib/clipboard-images';
  import { terminalControl } from '../stores/terminal-control.svelte';
  import { terminalFontFamily, terminalThemeFor } from '../lib/terminal-theme';
  import { appearanceTheme } from '../stores/appearance-theme.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { openDeviceBrowserUrl } from '../lib/browser-device-navigation';
  import { terminalLinkHandlers } from '../lib/terminal-links';
  import { FULL_TERMINAL_SCROLLBACK, writeTerminalData } from '../lib/terminal-write';
  import { restoreTerminalFocusOnWindowActivation } from '../lib/terminal-window-focus';
  import { loadTerminalScreenSnapshot } from '../lib/terminal-screen-snapshot';
  import { attachTerminalTouchScroll } from '../lib/terminal-touch-scroll';
  import TerminalTranscript from './TerminalTranscript.svelte';

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
  const terminalScrollback = FULL_TERMINAL_SCROLLBACK;
  let compactViewport = $state(window.matchMedia('(max-width: 767px)').matches);
  let terminalFontSize = $derived(fontSize);
  let inputLease = $derived(terminalControl.lease(terminalId));
  let ownsInput = $derived(terminalControl.owns(terminalId));
  let readOnly = $derived(Boolean(visible && inputLease && !ownsInput));
  const macosOverlayScrollbars = usesMacosOverlayScrollbars();

  let host: HTMLDivElement | undefined = $state();
  let findInput: HTMLInputElement | null = $state(null);
  let findOpen = $state(false);
  let findQuery = $state('');
  let ready = $state(false);
  let transitioningControl = $state(false);
  let preparedGeneration: number | null = null;
  let lastAuthoritativeSize: { cols: number; rows: number } | null = null;
  let loadingLabel = $derived(
    transitioningControl || (!inputLease && focused && visible)
      ? 'Taking control and preparing terminal…'
      : sessions.runtime[sessionId]?.status === 'starting'
        ? 'Starting'
        : 'Restoring terminal'
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
  // These assignments happen after the host binding effect has already run.
  // Keep them reactive so an initially-visible, newly created Session starts
  // its resize observer immediately instead of waiting for a tab switch to
  // change `visible` and accidentally wake the layout effect up.
  let term = $state.raw<Terminal | null>(null);
  let fit = $state.raw<FitAddon | null>(null);
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

  onMount(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => {
      compactViewport = media.matches;
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  });

  function shouldAutofocusTerminal(): boolean {
    return !compactViewport || !window.matchMedia('(pointer: coarse)').matches;
  }

  async function takeInputControl(): Promise<void> {
    if (transitioningControl || terminalControl.takingOver(terminalId)) return;
    transitioningControl = true;
    ready = false;
    try {
      const claimed = await terminalControl.takeover(terminalId);
      if (claimed) await prepareInteractiveTerminal(true);
    } finally {
      transitioningControl = false;
    }
  }

  function sendTerminalInput(data: string): void {
    if (!ownsInput) return;
    void terminalControl.input(terminalId, data).catch(() => {});
  }

  async function sendAuthoritativeResize(
    cols: number,
    rows: number,
    force = false
  ): Promise<void> {
    if (!ownsInput || !Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)) return;
    if (cols < 1 || rows < 1) return;
    if (!force && lastAuthoritativeSize?.cols === cols && lastAuthoritativeSize.rows === rows) {
      return;
    }
    lastAuthoritativeSize = { cols, rows };
    try {
      await terminalControl.resize(terminalId, cols, rows);
    } catch {
      lastAuthoritativeSize = null;
    }
  }

  async function prepareInteractiveTerminal(force = false): Promise<void> {
    const generation = inputLease?.generation;
    if (!ownsInput || !generation || !visible || !term || !fit || !host) return;
    if (!force && preparedGeneration === generation) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const rect = host.getBoundingClientRect();
    if (!host.isConnected || rect.width < 4 || rect.height < 4) return;
    terminalFit.fit(term, fit, () => ownsInput && visible && Boolean(host?.isConnected));
    await sendAuthoritativeResize(term.cols, term.rows, true);
    if (!ownsInput || inputLease?.generation !== generation) return;
    preparedGeneration = generation;
    if (capTimer === null) capTimer = setTimeout(markReady, READY_QUIET_MS);
    if (focused && shouldAutofocusTerminal()) term.focus();
  }

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
    if (!ownsInput) return;
    const session = sessions.sessions.find((item) => item.id === sessionId);
    if (session && effectiveAgentProvider(session)) {
      const images = await readClipboardImages().catch(() => []);
      if (images.length > 0) {
        await ipc.files.pasteImagesIntoTerminal({
          terminalId,
          sessionId,
          images,
          control: terminalControlProof(inputLease!)
        });
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
    try {
      return writeTerminalData(current, data, { onSettled: noteOutput });
    } catch (err) {
      console.warn('[DEBUG-xterm] write failed', { terminalId, sessionId, err });
      return Promise.resolve();
    }
  }

  function replaceOutput(data: string): Promise<void> {
    const current = term;
    if (!current) return Promise.resolve();
    try {
      return writeTerminalData(current, data, { replace: true, onSettled: noteOutput });
    } catch (err) {
      console.warn('[DEBUG-xterm] replay failed', { terminalId, sessionId, err });
      return Promise.resolve();
    }
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
    if (!host || !visible) return;
    ready = false;
    const initFontSize = untrack(() => terminalFontSize);
    const initScrollback = untrack(() => terminalScrollback);
    const terminalLinks = terminalLinkHandlers((uri) => {
      const deviceId = deviceSessions.localDevice?.deviceId;
      if (!deviceId) {
        reportError(new Error('The local Device identity is unavailable.'));
        return;
      }
      void openDeviceBrowserUrl(uri, deviceId).catch(reportError);
    });
    const t = new Terminal({
      fontFamily: terminalFontFamily,
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
      theme: untrack(() => terminalThemeFor(appearanceTheme.resolved)),
      allowProposedApi: true,
      scrollback: initScrollback,
      convertEol: false,
      linkHandler: terminalLinks.osc
    });
    const f = new FitAddon();
    const links = new WebLinksAddon(terminalLinks.web);
    const unicode11 = new Unicode11Addon();
    const clipboard = new ClipboardAddon();
    t.loadAddon(f);
    t.loadAddon(links);
    t.loadAddon(unicode11);
    t.loadAddon(clipboard);
    t.unicode.activeVersion = '11';
    // Mount before any network work so mobile browsers always get a real xterm
    // surface, even if a suspended snapshot request never settles.
    t.open(host);
    const detachTouchScroll = attachTerminalTouchScroll({
      target: host,
      scrollLines: (lines) => t.scrollLines(lines),
      rowHeight: () => {
        const height = host?.getBoundingClientRect().height ?? 0;
        return t.rows > 0 && height > 0 ? height / t.rows : 1;
      }
    });
    let disposed = false;
    let disposeInitialized = () => {
      detachTouchScroll();
      deferTerminalDispose(t);
    };
    void (async () => {
      let initialSeq = 0;
      try {
        const snapshot = await loadTerminalScreenSnapshot(
          () => ipc.terminal.screenSnapshot(terminalId)
        );
        if (disposed) return;
        if (snapshot?.sessionId === sessionId) {
          t.resize(snapshot.cols, snapshot.rows);
          await writeTerminalData(t, snapshot.data);
          initialSeq = snapshot.toSeq;
          markReady();
        }
      } catch {
        // Older Devices fall back to bounded raw replay through the output router.
      }
      if (disposed) return;
    const detachWindowFocus = restoreTerminalFocusOnWindowActivation({
      host,
      canRestore: () => (
        !disposed
        && focused
        && visible
        && document.visibilityState === 'visible'
        && shouldAutofocusTerminal()
      ),
      restore: async () => {
        if (!terminalControl.owns(terminalId)) await terminalControl.select(terminalId);
        if (!disposed && focused && visible && terminalControl.owns(terminalId)) t.focus();
      }
    });

    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ctrlSlash = ctrlSlashSequence(e);
      if (ctrlSlash !== null) {
        e.preventDefault();
        sendTerminalInput(ctrlSlash);
        return false;
      }

      if (tabIndexFromEvent(e) !== null) return false;
      if (shiftNumberIndexFromEvent(e) !== null) return false;
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
        sendTerminalInput(SHIFT_ENTER_SEQUENCE);
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
        if (Number.isFinite(t.cols) && Number.isFinite(t.rows) && ownsInput) {
          void sendAuthoritativeResize(t.cols, t.rows, true);
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
      untrack(() => visible),
      initialSeq
    );
    outputPresentation = presentation;

    const onInput = t.onData((data) => {
      sendTerminalInput(data);
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

    disposeInitialized = () => {
      detachTouchScroll();
      detachWindowFocus();
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
    })().catch(reportError);

    return () => {
      disposed = true;
      disposeInitialized();
    };
  });

  // Hidden panes own no browser xterm. The PTY-owning Runtime keeps their
  // headless screen current, so reveal restores one compact viewport and then
  // catches up only the sequence gap created during the snapshot request.
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
    const onRefocus = () => {
      if (shouldAutofocusTerminal()) term?.focus();
    };

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
    if (!focused || !visible) return;
    ready = false;
    void terminalControl.select(terminalId);
  });

  $effect(() => {
    if (!ownsInput) {
      preparedGeneration = null;
      lastAuthoritativeSize = null;
      return;
    }
    if (visible) void prepareInteractiveTerminal();
  });

  $effect(() => {
    if (!visible || !ownsInput || !term || !fit || !host) return;
    const currentTerm = term;
    const currentFit = fit;
    const currentHost = host;
    term.options.fontSize = terminalFontSize;
    // Font subsets and atlas repair are needed only for panes that can draw.
    // Browser font loads are cached, but avoiding four requests per hidden
    // terminal also avoids a Promise/listener fan-out during session restore.
    void Promise.all([
      document.fonts.load(`400 ${terminalFontSize}px "JetBrains Mono"`),
      document.fonts.load(`700 ${terminalFontSize}px "JetBrains Mono"`),
      document.fonts.load(`400 ${terminalFontSize}px "Cascadia Code"`, '─'),
      document.fonts.load(`700 ${terminalFontSize}px "Cascadia Code"`, '─')
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
            ownsInput &&
            term === currentTerm &&
            fit === currentFit &&
            host === currentHost &&
            currentHost.isConnected
        );
        void sendAuthoritativeResize(currentTerm.cols, currentTerm.rows);
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
    if (!visible || !ownsInput || !term || !fit || !host) return;
    const currentTerm = term;
    const currentFit = fit;
    const currentHost = host;
    currentTerm.options.cursorBlink = true;
    void attachRenderer(currentTerm);
    document.fonts.addEventListener('loadingdone', repaintFontAtlas);
    repaintFontAtlas();
    const canFit = () =>
      visible &&
      term === currentTerm &&
      fit === currentFit &&
      host === currentHost &&
      currentHost.isConnected;
    let scrollAfterFit = false;
    const scheduleFit = (
      scrollToBottom = false,
      measurement: { width: number; height: number } = currentHost.getBoundingClientRect()
    ) => {
      scrollAfterFit ||= scrollToBottom;
      terminalFit.scheduleMeasuredFit(
        currentTerm,
        currentFit,
        measurement,
        canFit,
        ({ cols, rows }) => {
          void sendAuthoritativeResize(cols, rows);
          if (scrollAfterFit) {
            scrollAfterFit = false;
            currentTerm.scrollToBottom();
          }
        },
        (err) => {
          console.warn('[DEBUG-xterm] scheduled layout fit failed', {
            terminalId,
            sessionId,
            err
          });
        }
      );
    };
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !visible || term !== currentTerm) return;
      const { width, height } = entry.contentRect;
      scheduleFit(false, { width, height });
    });
    const onRailLayout = (event: Event) => {
      const detail = (event as CustomEvent<{
        keyboardOpen?: boolean;
        keyboardClosed?: boolean;
      }>).detail;
      if (detail?.keyboardOpen) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => scheduleFit(true));
        });
        return;
      }
      if (detail?.keyboardClosed) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => scheduleFit(true));
        });
        return;
      }
      scheduleFit();
    };
    ro.observe(currentHost);
    window.addEventListener('soloe:rail-layout', onRailLayout);
    if (renderer && 'clearTextureAtlas' in renderer) {
      renderer.clearTextureAtlas();
    }
    currentTerm.refresh(0, currentTerm.rows - 1);
    scheduleFit();
    return () => {
      ro.disconnect();
      window.removeEventListener('soloe:rail-layout', onRailLayout);
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
    const colorTheme = terminalThemeFor(appearanceTheme.resolved);
    if (term?.options) term.options.theme = colorTheme;
  });

  $effect(() => {
    if (!focused || !ownsInput || !term) return;
    if (!shouldAutofocusTerminal()) return;
    requestAnimationFrame(() => term?.focus());
  });
</script>

<div
  class="terminal-pane-shell relative h-full w-full bg-[var(--terminal-background)]"
  data-overlay-scrollbars={macosOverlayScrollbars ? 'macos' : undefined}
>
  {#if (!ready && !readOnly) || transitioningControl}
    <div
      class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[var(--terminal-background)]"
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
  {#if readOnly}
    <div class="absolute inset-0 z-10 flex min-h-0 flex-col bg-[var(--terminal-background)]">
      <div class="flex items-center gap-2 border-b border-border bg-background/95 px-3 py-2 text-xs text-foreground">
        <span class="min-w-0 flex-1 truncate">
          Read-only — controlled by {inputLease?.controllerDeviceName ?? 'another client'}
        </span>
        <Button
          variant="outline"
          size="xs"
          disabled={transitioningControl || terminalControl.takingOver(terminalId)}
          onclick={() => void takeInputControl()}
        >Take Over</Button>
      </div>
      <div class="min-h-0 flex-1">
        <TerminalTranscript {terminalId} {sessionId} {visible} />
      </div>
    </div>
  {/if}
  {#if findOpen && focused && ownsInput}
    <div class="terminal-find absolute top-2.5 right-4 z-10 flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg">
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
  <div class:invisible={readOnly} class:pointer-events-none={readOnly} class="h-full w-full">
  <ContextMenu.Root onOpenChange={onMenuOpenChange}>
    <ContextMenu.Trigger>
      {#snippet child({ props })}
        <div {...props} class="h-full w-full min-w-0 overflow-hidden" bind:this={host}></div>
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
</div>

{#if chipText || askOpen}
  <button
    bind:this={chipEl}
    type="button"
    class="mobile-selection-menu fixed z-50 flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 font-sans text-[11px] text-popover-foreground shadow-md hover:bg-accent hover:text-accent-foreground"
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
    background: var(--terminal-background) !important;
    height: 100%;
  }
  :global(.xterm-screen),
  :global(.xterm-viewport) {
    background: var(--terminal-background) !important;
  }

  .terminal-pane-shell[data-overlay-scrollbars='macos'] :global(.xterm-viewport) {
    scrollbar-width: none;
  }

  .terminal-pane-shell[data-overlay-scrollbars='macos'] :global(.xterm-viewport::-webkit-scrollbar) {
    width: 0;
    height: 0;
  }

  @media (max-width: 767px) {
    .terminal-pane-shell {
      display: grid;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr);
      overflow: hidden;
    }

    .terminal-find {
      top: 0.5rem;
      right: 0.5rem;
      left: 0.5rem;
      flex-wrap: wrap;
    }

    .terminal-find :global([data-slot='input']) {
      width: min(100%, 15rem);
      height: 2.75rem;
      flex: 1 1 10rem;
    }

    .terminal-find :global([data-slot='button']) {
      min-width: 2.75rem;
      min-height: 2.75rem;
    }

    :global(.xterm-viewport) {
      -webkit-overflow-scrolling: touch;
      overscroll-behavior-y: contain;
      touch-action: pan-y;
    }

    :global(.xterm-helper-textarea) {
      font-size: 16px !important;
    }
  }
</style>
