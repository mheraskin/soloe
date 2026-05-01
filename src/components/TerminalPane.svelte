<script lang="ts">
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { SearchAddon } from '@xterm/addon-search';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import '@xterm/xterm/css/xterm.css';
  import { ipc } from '../lib/ipc';
  import type { TerminalId } from '@shared/types/terminal.js';
  import type { SessionId } from '@shared/types/sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError, toasts } from '../stores/toast.svelte';

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
    const s = new SearchAddon();
    const links = new WebLinksAddon((_event, uri) => {
      void ipc.system.openExternal(uri).catch(reportError);
    });
    t.loadAddon(f);
    t.loadAddon(s);
    t.loadAddon(links);
    t.open(host);
    try { f.fit(); } catch { /* container may be hidden */ }
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
      t.dispose();
      term = null;
      fit = null;
      search = null;
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

<div class="wrap">
  {#if findOpen && active}
    <div class="find">
      <input
        bind:this={findInput}
        bind:value={findQuery}
        oninput={onFindInput}
        onkeydown={(e) => {
          if (e.key === 'Escape') findOpen = false;
          if (e.key === 'Enter' && findQuery) search?.findNext(findQuery);
        }}
        placeholder="Find"
        aria-label="Find in terminal"
      />
      <button onclick={() => findQuery && search?.findPrevious(findQuery)}>Prev</button>
      <button onclick={() => findQuery && search?.findNext(findQuery)}>Next</button>
      <button onclick={() => (findOpen = false)} aria-label="Close find">Close</button>
    </div>
  {/if}
  <div class="host" bind:this={host}></div>
</div>

<style>
  .wrap {
    position: relative;
    width: 100%;
    height: 100%;
  }
  .host {
    width: 100%;
    height: 100%;
    padding: 8px;
    background: #0f0f10;
  }
  .find {
    position: absolute;
    top: 10px;
    right: 18px;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .find input {
    width: 180px;
    padding: 4px 6px;
  }
  .find button {
    padding: 4px 7px;
    font-size: 11px;
  }
  :global(.xterm) {
    height: 100%;
  }
  :global(.xterm-viewport) {
    background: transparent !important;
  }
</style>
