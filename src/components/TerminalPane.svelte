<script lang="ts">
  import { untrack } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { SearchAddon } from '@xterm/addon-search';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import { WebglAddon } from '@xterm/addon-webgl';
  import { CanvasAddon } from '@xterm/addon-canvas';
  import { Unicode11Addon } from '@xterm/addon-unicode11';
  import { ClipboardAddon } from '@xterm/addon-clipboard';
  import '@xterm/xterm/css/xterm.css';
  import { ipc } from '../lib/ipc';
  import type { TerminalId } from '@shared/types/terminal.js';
  import type { SessionId } from '@shared/types/sessions.js';
  import { effectiveAgentProvider, launchKind } from '@shared/types/sessions.js';
  import { settings } from '../stores/settings.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { nav } from '../stores/nav.svelte';
  import { rightRail } from '../stores/right-rail.svelte';
  import { reportError, toasts } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as ContextMenu from '$lib/components/ui/context-menu';
  import { Copy, Loader2, MessageSquarePlus, Send, X } from '@lucide/svelte';
  import AskAgentPopover from './ask-agent/AskAgentPopover.svelte';
  import { Keymap, projectIndexFromEvent, tabIndexFromEvent } from '../lib/keymap';
  import {
    AGENT_IMAGE_PASTE_SEQUENCE,
    isClipboardPasteShortcut,
    SHIFT_ENTER_SEQUENCE,
    shouldPasteImageViaSavedPath,
    shouldSendShiftEnterSequence
  } from '../lib/terminal-input';
  import type { ClipboardImagePayload } from '@shared/types/files.js';

  let {
    terminalId,
    sessionId,
    active
  }: { terminalId: TerminalId; sessionId: SessionId; active: boolean } = $props();

  let fontSize = $derived(settings.current.terminal.fontSize);

  let host: HTMLDivElement | undefined = $state();
  let findInput: HTMLInputElement | null = $state(null);
  let findOpen = $state(false);
  let findQuery = $state('');
  let ready = $state(false);
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
  let renderer: WebglAddon | CanvasAddon | null = null;
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

  function openFind(): void {
    if (!active) return;
    findOpen = true;
    requestAnimationFrame(() => findInput?.focus());
  }

  async function saveBuffer(): Promise<void> {
    if (!active) return;
    await ipc.system.saveText({
      defaultPath: `${terminalId}.log`,
      content: bufferText()
    });
  }

  async function copyBuffer(): Promise<void> {
    if (!active) return;
    await navigator.clipboard.writeText(bufferText());
    toasts.push('Copied terminal buffer', 'info');
  }

  async function copyMarkdown(): Promise<void> {
    if (!active) return;
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
  function writeOutput(data: string): void {
    if (!term) return;
    try {
      term.write(data);
      noteOutput(data.length);
    } catch (err) {
      console.warn('[DEBUG-xterm] write failed', { terminalId, sessionId, err });
    }
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
      cursorBlink: true,
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
    const s = new SearchAddon();
    const links = new WebLinksAddon((_event, uri) => {
      void ipc.system.openExternal(uri).catch(reportError);
    });
    const unicode11 = new Unicode11Addon();
    const clipboard = new ClipboardAddon();
    t.loadAddon(f);
    t.loadAddon(s);
    t.loadAddon(links);
    t.loadAddon(unicode11);
    t.loadAddon(clipboard);
    t.unicode.activeVersion = '11';
    t.open(host);

    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      if (tabIndexFromEvent(e) !== null) return false;
      if (projectIndexFromEvent(e) !== null) return false;
      if (Keymap.deleteSelectedSession.match(e)) {
        e.preventDefault();
        void nav.closeActive();
        return false;
      }
      if (Keymap.toggleNotesRail.match(e)) {
        e.preventDefault();
        rightRail.toggleTab('notes');
        return false;
      }
      if (Keymap.toggleDiffRail.match(e)) {
        e.preventDefault();
        rightRail.toggleTab('diff');
        return false;
      }
      if (Keymap.toggleFilesRail.match(e)) {
        e.preventDefault();
        rightRail.toggleTab('files');
        return false;
      }
      if (Keymap.toggleFeatureRail.match(e)) {
        e.preventDefault();
        rightRail.toggleTab('feature');
        return false;
      }
      for (const binding of Object.values(Keymap)) {
        if (binding.id === Keymap.deleteSelectedSession.id) continue;
        if (binding.id === Keymap.toggleNotesRail.id) continue;
        if (binding.id === Keymap.toggleDiffRail.id) continue;
        if (binding.id === Keymap.toggleFilesRail.id) continue;
        if (binding.id === Keymap.toggleFeatureRail.id) continue;
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

    // Renderer: prefer WebGL, fall back to Canvas, then DOM.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      t.loadAddon(webgl);
      renderer = webgl;
    } catch (err) {
      console.warn('[DEBUG-xterm] WebGL renderer unavailable, falling back to canvas', {
        terminalId,
        sessionId,
        err
      });
      try {
        const canvas = new CanvasAddon();
        t.loadAddon(canvas);
        renderer = canvas;
      } catch (err2) {
        console.warn('[DEBUG-xterm] Canvas renderer unavailable, using DOM', {
          terminalId,
          sessionId,
          err: err2
        });
      }
    }

    // fontsource splits each weight into unicode-range subsets the browser
    // fetches lazily when a glyph in that range first renders. xterm-addon-webgl
    // caches measured glyphs in a texture atlas, so cells that fell back to the
    // system font stay cached after the matching subset finishes loading — the
    // TUI looks garbled until a scroll or refresh evicts those entries. Repaint
    // on every batch of font loads (initial preload plus lazy subsets fetched
    // on demand) so no stale fallback glyphs survive.
    const fontPx = initFontSize;
    let fontsDisposed = false;
    const dropAtlasAndRepaint = () => {
      if (fontsDisposed) return;
      if (renderer && 'clearTextureAtlas' in renderer) {
        renderer.clearTextureAtlas();
      }
      // Wait a frame so the browser commits the newly-loaded font to the
      // render tree before xterm re-rasterises the atlas.
      requestAnimationFrame(() => {
        if (fontsDisposed) return;
        if (renderer && 'clearTextureAtlas' in renderer) {
          renderer.clearTextureAtlas();
        }
        t.refresh(0, t.rows - 1);
      });
    };
    void Promise.all([
      document.fonts.load(`400 ${fontPx}px "JetBrains Mono"`),
      document.fonts.load(`700 ${fontPx}px "JetBrains Mono"`),
      document.fonts.load(`400 ${fontPx}px "Cascadia Code"`, '─'),
      document.fonts.load(`700 ${fontPx}px "Cascadia Code"`, '─')
    ]).then(dropAtlasAndRepaint).catch(() => {});
    document.fonts.addEventListener('loadingdone', dropAtlasAndRepaint);

    requestAnimationFrame(() => {
      if (!active) return;
      try {
        f.fit();
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
    search = s;

    let nextSeq = 1;
    const offOutput = ipc.terminal.onOutput((e) => {
      if (e.terminalId !== terminalId) return;
      if (e.seq !== nextSeq) {
        console.warn('output seq gap', { terminalId, expected: nextSeq, got: e.seq });
      }
      nextSeq = e.seq + 1;
      writeOutput(e.data);
    });

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

    const onDocMouseDown = (e: MouseEvent) => {
      if (askOpen) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (host && host.contains(target)) return;
      if (chipEl && chipEl.contains(target)) return;
      clearChip();
      // Also drop xterm's highlight so the "selection" visually goes with
      // the chip — matches "click in another place clears the selection".
      term?.clearSelection();
    };
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (askOpen) return;
      if (!chipText) return;
      clearChip();
      term?.clearSelection();
    };
    window.addEventListener('mousedown', onDocMouseDown, true);
    window.addEventListener('keydown', onDocKeyDown);

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      if (!active) return;
      const { width, height } = entry.contentRect;
      if (width < 4 || height < 4) return; // hidden / collapsed
      try {
        f.fit();
        void ipc.terminal.resize(terminalId, t.cols, t.rows).catch(() => {});
      } catch (err) {
        console.warn('[DEBUG-xterm] resize observer fit failed', { terminalId, sessionId, err });
      }
    });
    ro.observe(host);

    const onFind = () => openFind();
    const onSave = () => { void saveBuffer().catch(reportError); };
    const onCopy = () => { void copyBuffer().catch(reportError); };
    const onCopyMarkdown = () => { void copyMarkdown().catch(reportError); };
    const onRefocus = () => { if (active) term?.focus(); };
    window.addEventListener('soloe:terminal-find', onFind);
    window.addEventListener('soloe:terminal-save-buffer', onSave);
    window.addEventListener('soloe:terminal-copy-buffer', onCopy);
    window.addEventListener('soloe:terminal-copy-markdown', onCopyMarkdown);
    window.addEventListener('soloe:refocus-terminal', onRefocus);

    return () => {
      fontsDisposed = true;
      document.fonts.removeEventListener('loadingdone', dropAtlasAndRepaint);
      window.removeEventListener('soloe:terminal-find', onFind);
      window.removeEventListener('soloe:terminal-save-buffer', onSave);
      window.removeEventListener('soloe:terminal-copy-buffer', onCopy);
      window.removeEventListener('soloe:terminal-copy-markdown', onCopyMarkdown);
      window.removeEventListener('soloe:refocus-terminal', onRefocus);
      host?.removeEventListener('mouseup', onHostMouseUp);
      host?.removeEventListener('mousedown', onHostMouseDown);
      window.removeEventListener('mousedown', onDocMouseDown, true);
      window.removeEventListener('keydown', onDocKeyDown);
      ro.disconnect();
      onInput.dispose();
      offOutput();
      renderer?.dispose();
      clipboard.dispose();
      unicode11.dispose();
      t.dispose();
      term = null;
      fit = null;
      search = null;
      renderer = null;
      clearReadyTimers();
    };
  });

  $effect(() => {
    if (!term || !fit || !host) return;
    term.options.fontSize = fontSize;
    requestAnimationFrame(() => {
      if (!host) return;
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      try {
        fit?.fit();
        if (term) {
          void ipc.terminal.resize(terminalId, term.cols, term.rows).catch(() => {});
        }
      } catch (err) {
        console.warn('[DEBUG-xterm] font-size fit failed', { terminalId, sessionId, err });
      }
    });
  });

  // When this pane becomes active, refit, focus, and evict the glyph atlas.
  // While hidden (opacity-0), the WebGL texture atlas can accumulate stale
  // fallback-font glyphs (lazy font subsets loaded after the terminal last
  // painted). Clearing it here forces a full re-rasterisation with the
  // correct fonts on every tab switch.
  $effect(() => {
    if (!active || !term || !fit || !host) return;
    if (renderer && 'clearTextureAtlas' in renderer) {
      renderer.clearTextureAtlas();
    }
    term.refresh(0, term.rows - 1);
    requestAnimationFrame(() => {
      if (!host) return;
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      try {
        fit?.fit();
        term?.focus();
        if (term) {
          void ipc.terminal.resize(terminalId, term.cols, term.rows).catch(() => {});
        }
      } catch (err) {
        console.warn('[DEBUG-xterm] active fit failed', { terminalId, sessionId, err });
      }
    });
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
          Starting
        </span>
      </div>
    </div>
  {/if}
  {#if findOpen && active}
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
