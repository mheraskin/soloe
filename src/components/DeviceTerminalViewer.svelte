<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { X } from '@lucide/svelte';
  import '@xterm/xterm/css/xterm.css';

  import type { TerminalRef } from '@shared/types/devices.js';
  import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
  import type { TerminalOutputEvent } from '@shared/types/terminal.js';
  import { terminalFontFamily, terminalTheme } from '../lib/terminal-theme';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import {
    TerminalTranscriptFollowController,
    TerminalTranscriptProjector,
    type TranscriptRecord,
    type TranscriptSpan
  } from '../lib/terminal-transcript';

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

  onMount(() => {
    const ref = terminalRef;
    if (!host || !ref) {
      error = 'This Session has no running terminal to attach.';
      restoring = false;
      return;
    }

    const terminal = new Terminal({
      fontFamily: terminalFontFamily,
      fontSize: 12,
      fontWeight: 400,
      fontWeightBold: 700,
      minimumContrastRatio: 4.5,
      drawBoldTextInBrightColors: false,
      cursorStyle: 'bar',
      cursorBlink: true,
      scrollback: 5_000,
      convertEol: false,
      theme: terminalTheme,
      allowProposedApi: true
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);

    let active = true;
    let appliedSeq = 0;
    let restoringOutput = true;
    const pending = new Map<number, TerminalOutputEvent>();
    let outputQueue = Promise.resolve();
    let projectionFrame = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSize: { cols: number; rows: number } | null = null;
    const transcript = new TerminalTranscriptProjector({
      cols: inputLease?.lease?.cols ?? 120,
      rows: inputLease?.lease?.rows ?? 30,
      scrollback: 5_000
    });
    resizeTranscript = (cols, rows) => transcript.resize(cols, rows);

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
      await new Promise<void>((resolve) => terminal.write(data, resolve));
      await transcript.write(data);
      projectTranscript();
    };
    const recover = async (): Promise<void> => {
      if (restoringOutput || !active) return;
      restoringOutput = true;
      try {
        const replay = await deviceSessions.terminalReplay(ref, appliedSeq);
        if (!active) return;
        if (replay.snapshot) {
          await write(replay.snapshot.data);
          appliedSeq = Math.max(appliedSeq, replay.snapshot.toSeq);
        }
        for (const event of [...pending.values()].sort((left, right) => left.seq - right.seq)) {
          pending.delete(event.seq);
          if (event.seq <= appliedSeq) continue;
          if (event.seq !== appliedSeq + 1) break;
          await write(event.data);
          appliedSeq = event.seq;
        }
      } catch (cause) {
        if (active) error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        restoringOutput = false;
        restoring = false;
      }
    };
    const queueOutput = (event: TerminalOutputEvent): void => {
      if (!active || event.seq <= appliedSeq) return;
      if (restoringOutput || event.seq !== appliedSeq + 1) {
        pending.set(event.seq, event);
        if (!restoringOutput) void recover();
        return;
      }
      outputQueue = outputQueue.then(async () => {
        if (!active || event.seq <= appliedSeq) return;
        await write(event.data);
        appliedSeq = event.seq;
      });
    };

    const attachment = deviceSessions.acquireTerminalOutput(ref, queueOutput);
    void attachment.ready
      .then(async () => {
        const replay = await deviceSessions.terminalReplay(ref, 0);
        if (!active) return;
        if (replay.snapshot) {
          if (replay.snapshot.truncated) {
            await write('\r\n\u001b[33m[Earlier terminal output omitted]\u001b[0m\r\n');
          }
          await write(replay.snapshot.data);
          appliedSeq = replay.snapshot.toSeq;
        }
        restoringOutput = false;
        for (const event of [...pending.values()].sort((left, right) => left.seq - right.seq)) {
          pending.delete(event.seq);
          queueOutput(event);
        }
      })
      .catch((cause) => {
        if (active) error = cause instanceof Error ? cause.message : String(cause);
      })
      .finally(() => {
        if (active) restoring = false;
      });

    const resize = async (force = false): Promise<void> => {
      if (!active || !host?.isConnected || !deviceSessions.ownsTerminalInput(ref)) return;
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      try {
        fit.fit();
        if (!force && lastSize?.cols === terminal.cols && lastSize.rows === terminal.rows) return;
        lastSize = { cols: terminal.cols, rows: terminal.rows };
        await deviceSessions.terminalResize(ref, terminal.cols, terminal.rows);
        restoring = false;
        terminal.focus();
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
      if (!entry || entry.contentRect.width < 4 || entry.contentRect.height < 4) return;
      scheduleResize();
    });
    resizeObserver.observe(host);
    requestAnimationFrame(() => {
      void resize(true);
    });
    const input = terminal.onData((data) => {
      if (!deviceSessions.ownsTerminalInput(ref)) return;
      void deviceSessions.terminalInput(ref, data).catch((cause) => {
        if (active) error = cause instanceof Error ? cause.message : String(cause);
      });
    });

    return () => {
      active = false;
      attachment.dispose();
      input.dispose();
      resizeObserver.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      if (projectionFrame) cancelAnimationFrame(projectionFrame);
      transcript.dispose();
      resizeTranscript = () => undefined;
      terminal.dispose();
    };
  });

  $effect(() => {
    const ref = terminalRef;
    if (!ref || !pageVisible) return;
    void deviceSessions.claimTerminalInputControl(ref).then((claimed) => {
      if (claimed) void prepareInteractive();
    });
    const leaseRenewal = setInterval(() => {
      if (deviceSessions.ownsTerminalInput(ref)) {
        void deviceSessions.claimTerminalInputControl(ref);
      }
    }, 5_000);
    return () => {
      clearInterval(leaseRenewal);
      void deviceSessions.releaseTerminalInputControl(ref).catch(() => undefined);
    };
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
    return [
      span.foreground ? `color:${span.foreground}` : '',
      span.background ? `background-color:${span.background}` : '',
      span.bold ? 'font-weight:700' : '',
      span.italic ? 'font-style:italic' : '',
      span.underline ? 'text-decoration:underline' : '',
      span.dim ? 'opacity:.65' : ''
    ].filter(Boolean).join(';');
  }
</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden bg-[#0f0f10]">
  <header class="flex items-center gap-2 border-b border-border bg-background px-3 py-2">
    <div class="min-w-0 flex-1">
      <p class="m-0 truncate text-xs font-medium">{projection.session.name}</p>
      <p class="m-0 truncate text-[10px] text-muted-foreground">
        {projection.deviceName} · {projection.runtime?.status ?? 'stopped'}
      </p>
    </div>
    <button
      type="button"
      class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      aria-label="Close remote terminal"
      title="Close remote terminal"
      onclick={onClose}
    >
      <X class="size-4" />
    </button>
  </header>
  <div class="relative min-h-72 flex-1">
    <div class="absolute inset-0" class:invisible={readOnly} bind:this={host}></div>
    {#if readOnly}
      <div class="absolute inset-0 flex min-h-0 flex-col bg-[#0f0f10]">
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
          class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 font-mono text-xs leading-5 text-[#e5e5e5] select-text"
          onscroll={observeTranscriptScroll}
        >
          {#each transcriptRecords as record (record.id)}
            <div class="transcript-line min-h-5" class:opacity-90={record.transient}>
              {#each record.spans as span}
                <span style={spanStyle(span)}>{span.text}</span>
              {/each}
            </div>
          {/each}
        </div>
      </div>
    {/if}
    {#if (restoring && !readOnly) || takingControl}
      <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 text-xs text-muted-foreground">
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
  .transcript-line {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
</style>
