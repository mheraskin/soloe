<script lang="ts">
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';
  import { ipc } from '../lib/ipc';
  import type { TerminalId } from '@shared/types/terminal.js';

  let {
    terminalId,
    active
  }: { terminalId: TerminalId; active: boolean } = $props();

  let host: HTMLDivElement | undefined = $state();
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;

  $effect(() => {
    if (!host) return;
    const t = new Terminal({
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      theme: {
        background: '#0f0f10',
        foreground: '#e6e6e6',
        cursor: '#6cf'
      },
      allowProposedApi: true,
      scrollback: 5000,
      cursorBlink: true,
      convertEol: false
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host);
    try { f.fit(); } catch { /* container may be hidden */ }
    term = t;
    fit = f;

    let nextSeq = 1;
    const offOutput = ipc.terminal.onOutput((e) => {
      if (e.terminalId !== terminalId) return;
      if (e.seq !== nextSeq) {
        console.warn('output seq gap', { terminalId, expected: nextSeq, got: e.seq });
      }
      nextSeq = e.seq + 1;
      t.write(e.data);
    });

    const onInput = t.onData((data) => {
      void ipc.terminal.input(terminalId, data).catch(() => {
        // silent — terminal probably exited
      });
    });

    const ro = new ResizeObserver(() => {
      try {
        f.fit();
        void ipc.terminal.resize(terminalId, t.cols, t.rows).catch(() => {});
      } catch {
        // hidden / zero size
      }
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      onInput.dispose();
      offOutput();
      t.dispose();
      term = null;
      fit = null;
    };
  });

  // When this pane becomes active, refit and focus on next frame.
  $effect(() => {
    if (!active || !term || !fit) return;
    requestAnimationFrame(() => {
      try {
        fit?.fit();
        term?.focus();
        if (term) {
          void ipc.terminal.resize(terminalId, term.cols, term.rows).catch(() => {});
        }
      } catch {
        // ignore
      }
    });
  });
</script>

<div class="host" bind:this={host}></div>

<style>
  .host {
    width: 100%;
    height: 100%;
    padding: 8px;
    background: #0f0f10;
  }
  :global(.xterm) {
    height: 100%;
  }
  :global(.xterm-viewport) {
    background: transparent !important;
  }
</style>
