<script lang="ts">
  import { onMount } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { X } from '@lucide/svelte';
  import '@xterm/xterm/css/xterm.css';

  import type { CockpitSessionProjection } from '@shared/types/cockpit.js';
  import type { TerminalOutputEvent } from '@shared/types/terminal.js';
  import { cockpit } from '../stores/cockpit.svelte';

  let {
    projection,
    onClose
  }: {
    projection: CockpitSessionProjection;
    onClose: () => void;
  } = $props();

  let host: HTMLDivElement | undefined = $state();
  let error = $state<string | null>(null);
  let restoring = $state(true);
  let takingControl = $state(false);
  let terminalRef = $derived(projection.runtime?.terminalRef ?? null);
  let inputLease = $derived(
    terminalRef ? cockpit.terminalInputLeaseEvent(terminalRef) : null
  );

  async function takeInputControl(): Promise<void> {
    if (!terminalRef || takingControl) return;
    takingControl = true;
    try {
      await cockpit.takeTerminalInputControl(terminalRef);
      error = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      takingControl = false;
    }
  }

  onMount(() => {
    if (!host || !terminalRef) {
      error = 'This Session has no running terminal to attach.';
      restoring = false;
      return;
    }

    const terminal = new Terminal({
      fontFamily: 'JetBrains Mono, Cascadia Code, ui-monospace, monospace',
      fontSize: 12,
      cursorStyle: 'bar',
      cursorBlink: true,
      scrollback: 5_000,
      convertEol: false,
      theme: {
        background: '#0f0f10',
        foreground: '#e6e6e6',
        cursor: '#e6e6e6',
        selectionBackground: '#283457',
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
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);

    let active = true;
    let appliedSeq = 0;
    let restoringOutput = true;
    const pending = new Map<number, TerminalOutputEvent>();
    let outputQueue = Promise.resolve();

    const write = (data: string): Promise<void> => new Promise((resolve) => {
      terminal.write(data, resolve);
    });
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
    const recover = async (): Promise<void> => {
      if (restoringOutput || !active) return;
      restoringOutput = true;
      try {
        const replay = await cockpit.terminalReplay(terminalRef, appliedSeq);
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

    const attachment = cockpit.acquireTerminalOutput(terminalRef, queueOutput);
    void attachment.ready
      .then(async () => {
        const replay = await cockpit.terminalReplay(terminalRef, 0);
        if (!active) return;
        if (replay.snapshot) {
          if (replay.snapshot.truncated) {
            await write('\r\n\x1b[33m[Earlier terminal output omitted]\x1b[0m\r\n');
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

    const resize = (): void => {
      if (!active || !host?.isConnected) return;
      try {
        fit.fit();
        void cockpit.terminalResize(terminalRef, terminal.cols, terminal.rows).catch((cause) => {
          if (active) error = cause instanceof Error ? cause.message : String(cause);
        });
      } catch {
        // A zero-sized settings panel will be fitted on the next observation.
      }
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    requestAnimationFrame(() => {
      resize();
      terminal.focus();
    });
    const input = terminal.onData((data) => {
      void cockpit.terminalInput(terminalRef, data).catch((cause) => {
        if (active) error = cause instanceof Error ? cause.message : String(cause);
      });
    });

    return () => {
      active = false;
      attachment.dispose();
      input.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
    };
  });
</script>

<section class="flex min-h-80 flex-col overflow-hidden rounded-md border border-border bg-[#0f0f10]">
  <header class="flex items-center gap-2 border-b border-border bg-background px-3 py-2">
    <div class="min-w-0 flex-1">
      <p class="m-0 truncate text-xs font-medium">{projection.session.name}</p>
      <p class="m-0 truncate text-[10px] text-muted-foreground">
        {projection.deviceName} · {projection.runtime?.state.status ?? 'stopped'}
      </p>
      {#if inputLease?.lease}
        <p class="m-0 truncate text-[10px] text-muted-foreground">
          Input: {inputLease.lease.ownerId} · until {new Date(inputLease.lease.expiresAt).toLocaleTimeString()}
        </p>
      {/if}
    </div>
    <button
      type="button"
      class="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      aria-label="Close Device terminal"
      title="Close terminal attachment"
      onclick={onClose}
    >
      <X class="size-4" />
    </button>
  </header>
  <div class="relative min-h-72 flex-1">
    <div class="absolute inset-0 p-1" bind:this={host}></div>
    {#if restoring}
      <div class="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 text-xs text-muted-foreground">
        Restoring terminal…
      </div>
    {/if}
  </div>
  {#if error}
    <div class="flex items-center gap-2 border-t border-border bg-destructive/10 px-3 py-1.5 text-[10px] text-destructive">
      <p class="m-0 min-w-0 flex-1">{error}</p>
      <button
        type="button"
        class="rounded border border-destructive/40 px-2 py-1 font-medium hover:bg-destructive/10 disabled:opacity-50"
        disabled={takingControl || !terminalRef}
        onclick={takeInputControl}
      >
        {takingControl ? 'Taking control…' : 'Take input control'}
      </button>
    </div>
  {/if}
</section>
