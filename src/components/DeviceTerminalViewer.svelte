<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import type { CanvasAddon as CanvasRendererAddon } from '@xterm/addon-canvas';
  import type { WebglAddon as WebglRendererAddon } from '@xterm/addon-webgl';
  import { FitAddon } from '@xterm/addon-fit';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import '@xterm/xterm/css/xterm.css';

  import type { TerminalRef } from '@shared/types/devices.js';
  import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
  import type { TerminalOutputEvent } from '@shared/types/terminal.js';
  import { effectiveAgentProvider } from '@shared/types/sessions.js';
  import {
    terminalFontFamily,
    terminalThemeFor,
    terminalTranscriptColor
  } from '../lib/terminal-theme';
  import { appearanceTheme } from '../stores/appearance-theme.svelte';
  import { FULL_TERMINAL_SCROLLBACK, writeTerminalData } from '../lib/terminal-write';
  import { readClipboardImages } from '../lib/clipboard-images';
  import { isClipboardPasteShortcut } from '../lib/terminal-input';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { openDeviceBrowserUrl } from '../lib/browser-device-navigation';
  import { terminalLinkHandlers } from '../lib/terminal-links';
  import { restoreTerminalFocusOnWindowActivation } from '../lib/terminal-window-focus';
  import { TerminalFitController } from '../lib/terminal-fit';
  import {
    TerminalTranscriptFollowController,
    TerminalTranscriptProjector,
    type TranscriptRecord,
    type TranscriptSpan
  } from '../lib/terminal-transcript';
  import SessionToolbar from './SessionToolbar.svelte';

  // Resumed agent TUIs repaint their saved conversation as live PTY output.
  // Keep that startup burst covered, then expose one settled xterm frame.
  const STARTUP_RESTORE_RECENCY_MS = 60_000;
  const STARTUP_RESTORE_QUIET_MS = 2_000;
  const STARTUP_RESTORE_NO_OUTPUT_MS = 8_000;
  const STARTUP_RESTORE_MAX_WAIT_MS = 30_000;

  let {
    projection,
    onClose
  }: {
    projection: MultiDeviceSessionView;
    onClose: () => void;
  } = $props();

  let host: HTMLDivElement | undefined = $state();
  let error = $state<string | null>(null);
  let restoring = $state(true);
  let takingControl = $state(false);
  let transcriptScroller: HTMLDivElement | undefined = $state();
  let transcriptRecords = $state.raw<TranscriptRecord[]>([]);
  let activeTerminal = $state.raw<Terminal | null>(null);
  const transcriptFollow = new TerminalTranscriptFollowController();
  let pageVisible = $state(document.visibilityState === 'visible');
  let prepareInteractive = async (): Promise<void> => undefined;
  let resizeTranscript = (_cols: number, _rows: number): void => undefined;
  let terminalRef = $derived<TerminalRef | null>(
    projection.runtime?.terminalId
      ? { deviceId: projection.ref.deviceId, terminalId: projection.runtime.terminalId }
      : null
  );
  let inputLease = $derived(
    terminalRef ? deviceSessions.terminalInputLeaseEvent(terminalRef) : null
  );
  let ownsInput = $derived(
    terminalRef ? deviceSessions.ownsTerminalInput(terminalRef) : false
  );
  let readOnly = $derived(Boolean(inputLease?.lease && !ownsInput));

  function compactTouchViewport(): boolean {
    return window.matchMedia('(max-width: 767px)').matches
      && window.matchMedia('(pointer: coarse)').matches;
  }

  function mobileKeyboardOpen(): boolean {
    return window.matchMedia('(max-width: 767px)').matches
      && document.documentElement.hasAttribute('data-mobile-keyboard-open');
  }

  function isFreshAgentStartup(view: MultiDeviceSessionView, now = Date.now()): boolean {
    if (!effectiveAgentProvider(view.session)) return false;
    const startedAt = Date.parse(view.runtime?.startedAt ?? '');
    if (!Number.isFinite(startedAt)) return false;
    const age = now - startedAt;
    return age >= -STARTUP_RESTORE_RECENCY_MS && age <= STARTUP_RESTORE_RECENCY_MS;
  }

  async function takeInputControl(): Promise<void> {
    if (!terminalRef || takingControl) return;
    takingControl = true;
    try {
      const claimed = await deviceSessions.claimTerminalInputControl(terminalRef, true);
      if (!claimed) throw new Error('Input control is still held by another device.');
      await prepareInteractive();
      error = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      takingControl = false;
    }
  }

  async function pasteFromClipboard(terminal: Terminal, ref: TerminalRef): Promise<void> {
    if (effectiveAgentProvider(projection.session)) {
      const images = await readClipboardImages().catch(() => []);
      if (images.length > 0) {
        await deviceSessions.pasteImagesIntoTerminal(
          ref,
          projection.ref.sessionId,
          images
        );
        return;
      }
    }
    const text = await navigator.clipboard.readText().catch(() => '');
    if (text) terminal.paste(text);
  }

  onMount(() => {
    const ref = terminalRef;
    if (!host || !ref) {
      error = 'This Session has no running terminal to attach.';
      restoring = false;
      return;
    }

    const terminalLinks = terminalLinkHandlers((uri) => {
      void openDeviceBrowserUrl(uri, projection.ref.deviceId).catch((cause) => {
        error = cause instanceof Error ? cause.message : String(cause);
      });
    });
    const terminal = new Terminal({
      fontFamily: terminalFontFamily,
      fontSize: 12,
      fontWeight: 400,
      fontWeightBold: 700,
      lineHeight: 1.0,
      letterSpacing: 0,
      minimumContrastRatio: 4.5,
      drawBoldTextInBrightColors: false,
      rescaleOverlappingGlyphs: false,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'outline',
      cursorBlink: true,
      scrollback: FULL_TERMINAL_SCROLLBACK,
      convertEol: false,
      macOptionIsMeta: true,
      theme: terminalThemeFor(appearanceTheme.resolved),
      allowProposedApi: true,
      linkHandler: terminalLinks.osc
    });
    const fit = new FitAddon();
    const terminalFit = new TerminalFitController();
    const links = new WebLinksAddon(terminalLinks.web);
    terminal.loadAddon(fit);
    terminal.loadAddon(links);
    terminal.attachCustomKeyEventHandler((event) => {
      if (!isClipboardPasteShortcut(event)) return true;
      event.preventDefault();
      void pasteFromClipboard(terminal, ref).catch((cause) => {
        error = cause instanceof Error ? cause.message : String(cause);
      });
      return false;
    });
    let disposed = false;
    let active = true;
    let stabilizingStartup = isFreshAgentStartup(projection);
    let startupRestoreGeneration = 0;
    let startupRestoreQuietTimer: ReturnType<typeof setTimeout> | null = null;
    let startupRestoreMaxTimer: ReturnType<typeof setTimeout> | null = null;
    let renderer: { dispose(): void } | null = null;
    let rendererLoadToken = 0;
    const attachCanvasRenderer = async (token: number): Promise<void> => {
      let canvas: CanvasRendererAddon | null = null;
      try {
        const { CanvasAddon } = await import('@xterm/addon-canvas');
        if (token !== rendererLoadToken || disposed || !active) return;
        canvas = new CanvasAddon();
        terminal.loadAddon(canvas);
        renderer = canvas;
        terminal.refresh(0, terminal.rows - 1);
      } catch {
        canvas?.dispose();
      }
    };
    const attachRenderer = async (): Promise<void> => {
      const token = ++rendererLoadToken;
      let webgl: WebglRendererAddon | null = null;
      try {
        const { WebglAddon } = await import('@xterm/addon-webgl');
        if (token !== rendererLoadToken || disposed || !active) return;
        webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          if (renderer !== webgl) return;
          renderer = null;
          webgl?.dispose();
          const fallbackToken = ++rendererLoadToken;
          if (!disposed && active) void attachCanvasRenderer(fallbackToken);
        });
        terminal.loadAddon(webgl);
        renderer = webgl;
        terminal.refresh(0, terminal.rows - 1);
      } catch {
        webgl?.dispose();
        if (token === rendererLoadToken && !disposed && active) {
          await attachCanvasRenderer(token);
        }
      }
    };
    const pending = new Map<number, TerminalOutputEvent>();
    let routeOutput = (event: TerminalOutputEvent): void => {
      pending.set(event.seq, event);
    };
    const attachment = deviceSessions.acquireTerminalOutput(ref, (event) => routeOutput(event));
    let disposeInitialized = () => {
      active = false;
      attachment.dispose();
      terminal.dispose();
    };
    void (async () => {
      let initialSeq = 0;
      let initialData = '';
      await attachment.ready;
      if (disposed) return;
      try {
        const restored = await deviceSessions.terminalScreenSnapshot(ref);
        if (disposed) return;
        if (restored.snapshot) {
          terminal.resize(restored.snapshot.cols, restored.snapshot.rows);
          await writeTerminalData(terminal, restored.snapshot.data);
          initialSeq = restored.snapshot.toSeq;
          initialData = restored.snapshot.data;
        }
      } catch {
        // Older remote Devices use bounded raw replay below.
      }
      if (disposed) return;
      const initialReplay = await deviceSessions.terminalReplay(ref, initialSeq);
      if (disposed) return;
      if (initialReplay.snapshot && initialReplay.snapshot.toSeq > initialSeq) {
        const omitted = initialReplay.snapshot.truncated
          ? '\r\n\u001b[33m[Earlier terminal output omitted]\u001b[0m\r\n'
          : '';
        const replayData = `${omitted}${initialReplay.snapshot.data}`;
        if (replayData) await writeTerminalData(terminal, replayData);
        initialData += replayData;
        initialSeq = initialReplay.snapshot.toSeq;
      }
      if (disposed) return;
      terminal.open(host);
      void attachRenderer();
      activeTerminal = terminal;
      const detachWindowFocus = restoreTerminalFocusOnWindowActivation({
        host,
        canRestore: () => active && !disposed && !readOnly && !compactTouchViewport(),
        restore: async () => {
          const claimed = deviceSessions.ownsTerminalInput(ref)
            || await deviceSessions.claimTerminalInputControl(ref);
          if (!active || disposed || !claimed || readOnly) return;
          await prepareInteractive();
          if (active && !disposed && deviceSessions.ownsTerminalInput(ref)) terminal.focus();
        }
      });

    let appliedSeq = initialSeq;
    let coveredSeq = initialSeq;
    let restoringOutput = true;
    let outputQueue = Promise.resolve();
    let projectionFrame = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSize: { cols: number; rows: number } | null = null;
    const transcript = new TerminalTranscriptProjector({
      cols: terminal.cols,
      rows: terminal.rows,
      scrollback: FULL_TERMINAL_SCROLLBACK
    });
    resizeTranscript = (cols, rows) => transcript.resize(cols, rows);

    const clearStartupRestoreTimers = (): void => {
      if (startupRestoreQuietTimer) clearTimeout(startupRestoreQuietTimer);
      if (startupRestoreMaxTimer) clearTimeout(startupRestoreMaxTimer);
      startupRestoreQuietTimer = null;
      startupRestoreMaxTimer = null;
    };
    const revealRestoredTerminal = async (
      generation: number,
      force = false
    ): Promise<void> => {
      const queuedOutput = outputQueue;
      await queuedOutput;
      if (!active || disposed || !stabilizingStartup) return;
      if (
        !force
        && (generation !== startupRestoreGeneration || queuedOutput !== outputQueue)
      ) return;
      stabilizingStartup = false;
      clearStartupRestoreTimers();
      terminal.scrollToBottom();
      restoring = false;
    };
    const scheduleStartupReveal = (delay = STARTUP_RESTORE_QUIET_MS): void => {
      if (!stabilizingStartup) return;
      const generation = ++startupRestoreGeneration;
      if (startupRestoreQuietTimer) clearTimeout(startupRestoreQuietTimer);
      startupRestoreQuietTimer = setTimeout(() => {
        void revealRestoredTerminal(generation);
      }, delay);
    };

    const projectTranscript = (): void => {
      if (projectionFrame) return;
      const shouldFollow = transcriptFollow.shouldFollowNewOutput();
      projectionFrame = requestAnimationFrame(async () => {
        projectionFrame = 0;
        transcriptRecords = transcript.records();
        await tick();
        if (shouldFollow && transcriptScroller) {
          transcriptScroller.scrollTop = transcriptScroller.scrollHeight;
        }
      });
    };

    const write = async (data: string): Promise<void> => {
      scheduleStartupReveal();
      await writeTerminalData(terminal, data);
      await transcript.write(data);
      projectTranscript();
    };
    if (initialData) {
      await transcript.write(initialData);
      projectTranscript();
    }
    const recover = async (): Promise<void> => {
      if (restoringOutput || !active) return;
      restoringOutput = true;
      try {
        // A replay cursor is only authoritative after every already-accepted
        // live write has reached both terminal projections.
        await outputQueue;
        if (!active) return;
        const replay = await deviceSessions.terminalReplay(ref, appliedSeq);
        if (!active) return;
        if (replay.snapshot) {
          await write(replay.snapshot.data);
          appliedSeq = Math.max(appliedSeq, replay.snapshot.toSeq);
          coveredSeq = Math.max(coveredSeq, appliedSeq);
        }
        for (const event of [...pending.values()].sort((left, right) => left.seq - right.seq)) {
          pending.delete(event.seq);
          if (event.seq <= appliedSeq) continue;
          if (event.seq !== appliedSeq + 1) break;
          await write(event.data);
          appliedSeq = event.seq;
          coveredSeq = Math.max(coveredSeq, appliedSeq);
        }
        terminal.scrollToBottom();
      } catch (cause) {
        if (active) error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        restoringOutput = false;
        if (stabilizingStartup) scheduleStartupReveal();
        else restoring = false;
      }
    };
    const queueOutput = (event: TerminalOutputEvent): void => {
      if (!active || event.seq <= coveredSeq) return;
      if (restoringOutput || event.seq !== coveredSeq + 1) {
        pending.set(event.seq, event);
        if (!restoringOutput) void recover();
        return;
      }
      // Reserve the sequence before the asynchronous xterm write begins. A
      // following live event is contiguous with this in-flight write and must
      // queue behind it instead of triggering replay from the stale cursor.
      coveredSeq = event.seq;
      outputQueue = outputQueue.then(async () => {
        if (!active || event.seq <= appliedSeq) return;
        await write(event.data);
        appliedSeq = event.seq;
      });
    };

    routeOutput = queueOutput;
    restoringOutput = false;
    for (const event of [...pending.values()].sort((left, right) => left.seq - right.seq)) {
      pending.delete(event.seq);
      queueOutput(event);
    }
    terminal.scrollToBottom();
    if (stabilizingStartup) {
      startupRestoreMaxTimer = setTimeout(() => {
        void revealRestoredTerminal(startupRestoreGeneration, true);
      }, STARTUP_RESTORE_MAX_WAIT_MS);
      scheduleStartupReveal(
        initialSeq > 0 ? STARTUP_RESTORE_QUIET_MS : STARTUP_RESTORE_NO_OUTPUT_MS
      );
    } else {
      restoring = false;
    }

    const detachReconnect = deviceSessions.onDeviceReconnect(ref.deviceId, () => {
      void recover();
    });

    const resize = async (force = false): Promise<void> => {
      if (
        !active
        || !host?.isConnected
        || !deviceSessions.ownsTerminalInput(ref)
        || mobileKeyboardOpen()
      ) return;
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      try {
        const size = terminalFit.fit(terminal, fit, () => active && host?.isConnected === true);
        if (!force && lastSize?.cols === size.cols && lastSize.rows === size.rows) return;
        lastSize = size;
        await deviceSessions.terminalResize(ref, size.cols, size.rows);
        if (!stabilizingStartup) restoring = false;
        if (!compactTouchViewport()) terminal.focus();
      } catch {
        // A zero-sized panel will be fitted on the next observation.
      }
    };
    const scheduleResize = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => void resize(), 50);
    };
    prepareInteractive = () => resize(true);
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (
        !entry
        || mobileKeyboardOpen()
        || entry.contentRect.width < 4
        || entry.contentRect.height < 4
      ) return;
      scheduleResize();
    });
    const onViewportLayout = (event: Event): void => {
      const detail = (event as CustomEvent<{
        keyboardOpen?: boolean;
        keyboardClosed?: boolean;
      }>).detail;
      if (detail?.keyboardOpen) {
        terminal.scrollToBottom();
        return;
      }
      if (detail?.keyboardClosed) {
        requestAnimationFrame(() => requestAnimationFrame(() => void resize(true)));
        return;
      }
      scheduleResize();
    };
    resizeObserver.observe(host);
    window.addEventListener('soloe:rail-layout', onViewportLayout);
    requestAnimationFrame(() => {
      void resize(true);
    });
    const input = terminal.onData((data) => {
      void deviceSessions.terminalInput(ref, data).catch((cause) => {
        if (active) error = cause instanceof Error ? cause.message : String(cause);
      });
    });

    disposeInitialized = () => {
      active = false;
      rendererLoadToken += 1;
      renderer?.dispose();
      renderer = null;
      detachReconnect();
      detachWindowFocus();
      attachment.dispose();
      input.dispose();
      resizeObserver.disconnect();
      window.removeEventListener('soloe:rail-layout', onViewportLayout);
      if (resizeTimer) clearTimeout(resizeTimer);
      terminalFit.cancel();
      clearStartupRestoreTimers();
      if (projectionFrame) cancelAnimationFrame(projectionFrame);
      transcript.dispose();
      resizeTranscript = () => undefined;
      terminal.dispose();
      if (activeTerminal === terminal) activeTerminal = null;
    };
    })().catch((cause) => {
      if (!disposed) error = cause instanceof Error ? cause.message : String(cause);
    });

    return () => {
      disposed = true;
      disposeInitialized();
    };
  });

  $effect(() => {
    const colorTheme = terminalThemeFor(appearanceTheme.resolved);
    if (activeTerminal?.options) activeTerminal.options.theme = colorTheme;
  });

  $effect(() => {
    const ref = terminalRef;
    if (!ref || !pageVisible) return;
    void deviceSessions.claimTerminalInputControl(ref).then((claimed) => {
      if (claimed) void prepareInteractive();
    });
  });

  onMount(() => {
    const onVisibility = () => {
      pageVisible = document.visibilityState === 'visible';
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  $effect(() => {
    const lease = inputLease?.lease;
    if (!lease) return;
    // The transcript parser uses canonical geometry internally; CSS controls visible reflow.
    resizeTranscript(lease.cols, lease.rows);
  });

  function observeTranscriptScroll(): void {
    if (!transcriptScroller) return;
    transcriptFollow.observe(transcriptScroller);
  }

  function spanStyle(span: TranscriptSpan): string {
    const colorTheme = appearanceTheme.resolved;
    return [
      span.foreground ? `color:${terminalTranscriptColor(span.foreground, colorTheme)}` : '',
      span.background
        ? `background-color:${terminalTranscriptColor(span.background, colorTheme)}`
        : '',
      span.bold ? 'font-weight:700' : '',
      span.italic ? 'font-style:italic' : '',
      span.underline ? 'text-decoration:underline' : '',
      span.dim ? 'opacity:.65' : ''
    ].filter(Boolean).join(';');
  }
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--terminal-background)]">
  <SessionToolbar {projection} {onClose} />
  <div class="relative min-h-0 flex-1 overflow-hidden">
    <div class="absolute inset-0" class:invisible={readOnly} bind:this={host}></div>
    {#if readOnly}
      <div class="absolute inset-0 flex min-h-0 flex-col bg-[var(--terminal-background)]">
        <div class="flex items-center gap-2 border-b border-border bg-background/95 px-3 py-2 text-xs text-foreground">
          <span class="min-w-0 flex-1 truncate">
            Read-only — controlled by {inputLease?.lease?.controllerDeviceName ?? 'another client'}
          </span>
          <button
            type="button"
            class="rounded border border-border px-2 py-1 font-medium hover:bg-accent disabled:opacity-50"
            disabled={takingControl || !terminalRef}
            onclick={takeInputControl}
          >Take Over</button>
        </div>
        <div
          bind:this={transcriptScroller}
          class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 font-mono text-xs leading-5 text-[var(--terminal-foreground)] select-text"
          onscroll={observeTranscriptScroll}
        >
          {#each transcriptRecords as record (record.id)}
            <div class="transcript-line min-h-5" class:opacity-90={record.transient}>
              {#each record.spans as span, spanIndex (spanIndex)}
                <span style={spanStyle(span)}>{span.text}</span>
              {/each}
            </div>
          {/each}
        </div>
      </div>
    {/if}
    {#if restoring || takingControl}
      <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--terminal-background)] text-xs text-muted-foreground">
        {takingControl ? 'Taking control and preparing terminal…' : 'Restoring terminal…'}
      </div>
    {/if}
  </div>
  {#if error}
    <div class="flex items-center gap-2 border-t border-border bg-destructive/10 px-3 py-1.5 text-[10px] text-destructive">
      <p class="m-0 min-w-0 flex-1">{error}</p>
    </div>
  {/if}
</section>

<style>
  :global(.xterm) {
    width: 100%;
    max-width: 100%;
    height: 100%;
  }

  .transcript-line {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  @media (max-width: 767px) {
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
