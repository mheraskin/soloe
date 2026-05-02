<script lang="ts">
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { SearchAddon } from '@xterm/addon-search';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import { WebglAddon } from '@xterm/addon-webgl';
  import { CanvasAddon } from '@xterm/addon-canvas';
  import '@xterm/xterm/css/xterm.css';
  import { ipc } from '../lib/ipc';
  import type { TerminalId } from '@shared/types/terminal.js';
  import type { SessionId } from '@shared/types/sessions.js';
  import { settings } from '../stores/settings.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError, toasts } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { X } from '@lucide/svelte';

  let {
    terminalId,
    sessionId,
    active
  }: { terminalId: TerminalId; sessionId: SessionId; active: boolean } = $props();

  let host: HTMLDivElement | undefined = $state();
  let findInput: HTMLInputElement | null = $state(null);
  let findOpen = $state(false);
  let findQuery = $state('');
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let search: SearchAddon | null = null;

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
      ? `# ${session.name || session.id}\n\n- cwd: ${session.cwd}\n- kind: ${session.kind}\n- run mode: ${session.runMode}\n\n`
      : `# ${sessionId}\n\n`;
    await navigator.clipboard.writeText(`${header}\`\`\`text\n${bufferText()}\`\`\`\n`);
    toasts.push('Copied session as Markdown', 'info');
  }

  function onFindInput(): void {
    if (!findQuery) return;
    search?.findNext(findQuery);
  }

  $effect(() => {
    if (!host) return;
    const t = new Terminal({
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      fontSize: settings.current.terminal.fontSize,
      lineHeight: 1.2,
      letterSpacing: 0,
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
    const s = new SearchAddon();
    const links = new WebLinksAddon((_event, uri) => {
      void ipc.system.openExternal(uri).catch(reportError);
    });
    t.loadAddon(f);
    t.loadAddon(s);
    t.loadAddon(links);
    t.open(host);

    // Renderer: prefer WebGL, fall back to Canvas, then DOM. The DOM renderer
    // breaks when written to while the host is hidden (we keep inactive panes
    // mounted with visibility:hidden), surfacing as a "Cannot read properties
    // of undefined (reading 'dimensions')" crash from Viewport.syncScrollArea.
    let renderer: WebglAddon | CanvasAddon | null = null;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      t.loadAddon(webgl);
      renderer = webgl;
    } catch (err) {
      console.warn('[terminal] WebGL renderer unavailable, falling back to canvas', err);
      try {
        const canvas = new CanvasAddon();
        t.loadAddon(canvas);
        renderer = canvas;
      } catch (err2) {
        console.warn('[terminal] Canvas renderer unavailable, using DOM', err2);
      }
    }

    requestAnimationFrame(() => {
      try { f.fit(); } catch { /* container may be hidden */ }
    });
    term = t;
    fit = f;
    search = s;

    console.info('[DEBUG-terminal-start] terminal pane mounted', {
      sessionId,
      terminalId
    });

    let nextSeq = 1;
    const offOutput = ipc.terminal.onOutput((e) => {
      if (e.terminalId !== terminalId) return;
      if (e.seq !== nextSeq) {
        console.warn('output seq gap', { terminalId, expected: nextSeq, got: e.seq });
      }
      nextSeq = e.seq + 1;
      try {
        t.write(e.data);
      } catch (err) {
        // Renderer may be temporarily unavailable (hidden pane, context loss).
        // Drop the write rather than crash the renderer process.
        console.warn('[terminal] write failed', err);
      }
    });

    const onInput = t.onData((data) => {
      void ipc.terminal.input(terminalId, data).catch(() => {
        // silent — terminal probably exited
      });
    });

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width < 4 || height < 4) return; // hidden / collapsed
      try {
        f.fit();
        void ipc.terminal.resize(terminalId, t.cols, t.rows).catch(() => {});
      } catch {
        // renderer not ready
      }
    });
    ro.observe(host);

    const onFind = () => openFind();
    const onSave = () => { void saveBuffer().catch(reportError); };
    const onCopy = () => { void copyBuffer().catch(reportError); };
    const onCopyMarkdown = () => { void copyMarkdown().catch(reportError); };
    window.addEventListener('soloe:terminal-find', onFind);
    window.addEventListener('soloe:terminal-save-buffer', onSave);
    window.addEventListener('soloe:terminal-copy-buffer', onCopy);
    window.addEventListener('soloe:terminal-copy-markdown', onCopyMarkdown);

    return () => {
      window.removeEventListener('soloe:terminal-find', onFind);
      window.removeEventListener('soloe:terminal-save-buffer', onSave);
      window.removeEventListener('soloe:terminal-copy-buffer', onCopy);
      window.removeEventListener('soloe:terminal-copy-markdown', onCopyMarkdown);
      ro.disconnect();
      onInput.dispose();
      offOutput();
      renderer?.dispose();
      t.dispose();
      term = null;
      fit = null;
      search = null;
    };
  });

  $effect(() => {
    if (!term || !fit || !host) return;
    term.options.fontSize = settings.current.terminal.fontSize;
    requestAnimationFrame(() => {
      if (!host) return;
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      try {
        fit?.fit();
        if (term) {
          void ipc.terminal.resize(terminalId, term.cols, term.rows).catch(() => {});
        }
      } catch {
        // ignore
      }
    });
  });

  // When this pane becomes active, refit and focus on next frame.
  $effect(() => {
    if (!active || !term || !fit || !host) return;
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
      } catch {
        // ignore
      }
    });
  });
</script>

<div class="relative h-full w-full bg-[#0f0f10] p-2">
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
  <div class="h-full w-full" bind:this={host}></div>
</div>

<style>
  :global(.xterm) {
    height: 100%;
  }
  :global(.xterm-viewport) {
    background: transparent !important;
  }
</style>
