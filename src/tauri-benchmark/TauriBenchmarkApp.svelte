<script lang="ts">
  import { onMount } from 'svelte';
  import { GhosttyTerminalSurface } from '../lib/ghostty/surface';
  import { darkTerminalTheme, terminalFontFamily } from '../lib/terminal-theme';
  import { TauriTerminalClient, type TauriSpikeInfo } from './tauri-terminal-client';
  import { runTauriBenchmark } from './run-tauri-benchmark';

  const client = new TauriTerminalClient();
  let host: HTMLDivElement;
  let terminal: GhosttyTerminalSurface | null = null;
  let info: TauriSpikeInfo | null = $state(null);
  let terminalId: string | null = $state(null);
  let status = $state('initializing');
  let error = $state('');
  let bytes = $state(0);
  let batches = $state(0);
  let startedAt = $state(0);
  let maxFrameGap = $state(0);
  let burstRunning = $state(false);
  let shell = $state('');
  let cwd = $state('');
  let cleanupOutput: (() => void) | null = null;
  let cleanupExit: (() => void) | null = null;

  const throughputMiBs = $derived(
    startedAt > 0 && bytes > 0
      ? bytes / 1024 / 1024 / ((performance.now() - startedAt) / 1000)
      : 0
  );

  onMount(() => {
    document.documentElement.classList.add('dark');
    let disposed = false;
    void GhosttyTerminalSurface.create(host, {
      theme: darkTerminalTheme,
      font: { family: terminalFontFamily, size: 13 },
      onData: (data) => {
        if (terminalId) void client.input(terminalId, data).catch(showError);
      },
      onResize: (cols, rows) => {
        if (terminalId) void client.resize(terminalId, cols, rows).catch(() => undefined);
      },
      onSelectionChange: () => undefined,
      beforeKey: () => true,
      onLinkActivate: () => undefined
    }).then((surface) => {
      if (disposed) {
        surface.dispose();
        return;
      }
      terminal = surface;
    }).catch(showError);

    let previousFrame = performance.now();
    let frameHandle = 0;
    const observeFrame = (now: number) => {
      maxFrameGap = Math.max(maxFrameGap, now - previousFrame);
      previousFrame = now;
      frameHandle = requestAnimationFrame(observeFrame);
    };
    frameHandle = requestAnimationFrame(observeFrame);

    void initialize();
    return () => {
      cleanupTerminalListeners();
      disposed = true;
      cancelAnimationFrame(frameHandle);
      if (terminalId) void client.stop(terminalId).catch(() => {});
      terminal?.dispose();
      terminal = null;
    };
  });

  async function initialize(): Promise<void> {
    try {
      await client.subscribe();
      info = await client.info();
      shell = info.shell;
      cwd = info.cwd;
      status = 'ready';
      if (info.benchmark) {
        const result = await runTauriBenchmark(client, info, (message) => {
          status = message;
        });
        status = 'benchmark · complete';
        await client.completeBenchmark(result);
      }
    } catch (cause) {
      showError(cause);
    }
  }

  async function start(): Promise<void> {
    if (!terminal || !info || terminalId) return;
    error = '';
    status = 'starting';
    const nextTerminalId = `tauri-${crypto.randomUUID()}`;
    const sessionId = `spike-${crypto.randomUUID()}`;
    cleanupOutput = client.onOutput(nextTerminalId, (data) => {
      if (startedAt === 0) startedAt = performance.now();
      bytes += data.byteLength;
      batches += 1;
      terminal?.write(data);
    });
    cleanupExit = client.onExit(nextTerminalId, (exitCode, signalName) => {
      terminal?.write(`\r\n[process exited: ${exitCode}${signalName ? `, ${signalName}` : ''}]\r\n`);
      terminalId = null;
      burstRunning = false;
      status = 'exited';
      cleanupTerminalListeners();
    });
    try {
      const result = await client.start({
        terminalId: nextTerminalId,
        sessionId,
        file: shell,
        args: info.platform === 'windows' ? ['-NoLogo'] : ['--noprofile', '--norc'],
        cwd,
        env: {},
        cols: terminal.cols,
        rows: terminal.rows
      });
      terminalId = result.terminalId;
      status = `running · pid ${result.pid}`;
      terminal.focus();
    } catch (cause) {
      cleanupTerminalListeners();
      showError(cause);
    }
  }

  async function stop(): Promise<void> {
    if (!terminalId) return;
    status = 'stopping';
    await client.stop(terminalId).catch(showError);
  }

  async function runBurst(): Promise<void> {
    if (!terminalId || burstRunning || info?.platform === 'windows') return;
    bytes = 0;
    batches = 0;
    startedAt = performance.now();
    maxFrameGap = 0;
    burstRunning = true;
    await client.input(
      terminalId,
      "yes x | head -c 1048576; printf '\\n[SOLOE_TAURI_BURST_DONE]\\n'\n"
    ).catch(showError);
    setTimeout(() => {
      burstRunning = false;
    }, 1500);
  }

  function resetMetrics(): void {
    bytes = 0;
    batches = 0;
    startedAt = 0;
    maxFrameGap = 0;
  }

  function cleanupTerminalListeners(): void {
    cleanupOutput?.();
    cleanupExit?.();
    cleanupOutput = null;
    cleanupExit = null;
  }

  function showError(cause: unknown): void {
    error = cause instanceof Error ? cause.message : String(cause);
    status = 'error';
  }
</script>

<svelte:head><title>Soloe — Tauri terminal spike</title></svelte:head>

<main class="spike-shell">
  <header>
    <div>
      <p class="eyebrow">Soloe migration laboratory</p>
      <h1>Tauri + Rust terminal spike</h1>
      <p class="subtitle">The Svelte/Ghostty WASM stack, backed directly by <code>soloe-terminal</code>.</p>
    </div>
    <span class:bad={status === 'error'} class="status">{status}</span>
  </header>

  <section class="controls">
    <label>Shell <input bind:value={shell} disabled={terminalId !== null} /></label>
    <label class="cwd">Working directory <input bind:value={cwd} disabled={terminalId !== null} /></label>
    {#if terminalId}
      <button onclick={stop}>Stop</button>
    {:else}
      <button class="primary" onclick={start} disabled={!info}>Start terminal</button>
    {/if}
    <button onclick={runBurst} disabled={!terminalId || burstRunning || info?.platform === 'windows'}>1 MiB paint burst</button>
    <button onclick={resetMetrics}>Reset metrics</button>
  </section>

  <section class="metrics" aria-label="live renderer metrics">
    <article><span>Output</span><strong>{(bytes / 1024 / 1024).toFixed(2)} MiB</strong></article>
    <article><span>Channel batches</span><strong>{batches}</strong></article>
    <article><span>Average throughput</span><strong>{throughputMiBs.toFixed(2)} MiB/s</strong></article>
    <article><span>Maximum frame gap</span><strong>{maxFrameGap.toFixed(1)} ms</strong></article>
  </section>

  {#if error}<p class="error">{error}</p>{/if}
  <section class="terminal-frame" aria-label="interactive terminal">
    <div class="terminal-host" bind:this={host}></div>
  </section>
  <footer>
    This is deliberately a comparison shell, not application parity. Electron remains the production shell.
  </footer>
</main>

<style>
  :global(html), :global(body), :global(#app) { height: 100%; margin: 0; }
  :global(body) { overflow: hidden; background: #111; color: #d8d8d8; font-family: var(--font-sans); }
  .spike-shell { box-sizing: border-box; display: grid; grid-template-rows: auto auto auto auto minmax(0, 1fr) auto; gap: 12px; height: 100%; padding: 18px; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
  h1 { margin: 2px 0 4px; color: #f4f4f4; font-size: 23px; font-weight: 650; letter-spacing: -0.02em; }
  p { margin: 0; }
  .eyebrow { color: #e49a63; font-size: 11px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
  .subtitle, footer { color: #8f8f8f; font-size: 12px; }
  code { color: #c9a884; }
  .status { border: 1px solid #365640; border-radius: 999px; background: #193021; color: #9ee2ad; padding: 5px 10px; font-family: var(--font-mono); font-size: 11px; }
  .status.bad { border-color: #6e3434; background: #351b1b; color: #ffabab; }
  .controls { display: flex; align-items: end; gap: 8px; }
  label { display: grid; gap: 4px; color: #999; font-size: 10px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; }
  label.cwd { flex: 1; }
  input, button { box-sizing: border-box; height: 31px; border: 1px solid #383838; border-radius: 6px; background: #1b1b1b; color: #ddd; padding: 0 10px; font: 12px var(--font-mono); }
  input { min-width: 180px; }
  label.cwd input { width: 100%; }
  button { cursor: pointer; font-family: var(--font-sans); font-weight: 600; white-space: nowrap; }
  button:hover:not(:disabled) { border-color: #666; background: #242424; }
  button.primary { border-color: #aa6637; background: #8d4c28; color: white; }
  button:disabled { cursor: default; opacity: .45; }
  .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  article { display: grid; gap: 2px; border: 1px solid #292929; border-radius: 7px; background: #181818; padding: 8px 10px; }
  article span { color: #818181; font-size: 10px; text-transform: uppercase; }
  article strong { color: #e4e4e4; font: 600 14px var(--font-mono); }
  .error { border: 1px solid #6e3434; border-radius: 6px; background: #351b1b; color: #ffb2b2; padding: 8px 10px; font-size: 12px; }
  .terminal-frame { min-height: 0; border: 1px solid #303030; border-radius: 8px; background: #171717; padding: 9px 7px; overflow: hidden; }
  .terminal-host { width: 100%; height: 100%; }
  footer { text-align: right; }
  @media (max-width: 850px) { .controls { flex-wrap: wrap; } .metrics { grid-template-columns: repeat(2, 1fr); } label.cwd { min-width: 50%; } }
</style>
