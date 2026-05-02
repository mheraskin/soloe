<script lang="ts">
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
  import { settings } from '../stores/settings.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError, toasts } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { X } from '@lucide/svelte';
  import { Keymap, projectIndexFromEvent, tabIndexFromEvent } from '../lib/keymap';

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
  let pendingOutput = '';

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

  function canRender(): boolean {
    if (!active || !host) return false;
    const rect = host.getBoundingClientRect();
    return rect.width >= 4 && rect.height >= 4;
  }

  function writeOutput(data: string): void {
    if (!term || !canRender()) {
      pendingOutput += data;
      return;
    }
    try {
      term.write(data);
    } catch (err) {
      pendingOutput = data + pendingOutput;
      console.warn('[DEBUG-xterm] write failed', { terminalId, sessionId, err });
    }
  }

  $effect(() => {
    if (!host) return;
    const t = new Terminal({
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      fontSize: settings.current.terminal.fontSize,
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
      smoothScrollDuration: 125,
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
      for (const binding of Object.values(Keymap)) {
        if (binding.match(e)) return false;
      }

      const ctrlOrCmd = (e.ctrlKey || e.metaKey) && !e.altKey;
      if (ctrlOrCmd && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        void navigator.clipboard.readText().then((text) => {
          if (!text) return;
          void ipc.terminal.input(terminalId, text).catch(() => {});
        }).catch(() => {});
        return false;
      }
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
    let renderer: WebglAddon | CanvasAddon | null = null;
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
      clipboard.dispose();
      unicode11.dispose();
      t.dispose();
      term = null;
      fit = null;
      search = null;
      pendingOutput = '';
    };
  });

  $effect(() => {
    if (!active || !term || !pendingOutput || !canRender()) return;
    const data = pendingOutput;
    pendingOutput = '';
    writeOutput(data);
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
      } catch (err) {
        console.warn('[DEBUG-xterm] font-size fit failed', { terminalId, sessionId, err });
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
      } catch (err) {
        console.warn('[DEBUG-xterm] active fit failed', { terminalId, sessionId, err });
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
