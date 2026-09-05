<script lang="ts">
  import { Copy, Loader2, MessageSquarePlus, Send, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as ContextMenu from '$lib/components/ui/context-menu';
  import type { TerminalId } from '@shared/types/terminal.js';
  import { terminalControlProof } from '@shared/types/terminal.js';
  import type { SessionId } from '@shared/types/sessions.js';
  import { effectiveAgentProvider, launchKind } from '@shared/types/sessions.js';
  import AskAgentPopover from './ask-agent/AskAgentPopover.svelte';
  import GhosttyTerminal from './GhosttyTerminal.svelte';
  import { ipc } from '../lib/ipc';
  import type {
    TerminalSessionConnection,
    TerminalSessionState
  } from '../lib/terminal-session';
  import { terminalFontFamily, terminalThemeFor } from '../lib/terminal-theme';
  import { appearanceTheme } from '../stores/appearance-theme.svelte';
  import { settings } from '../stores/settings.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { terminalControl } from '../stores/terminal-control.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { nav } from '../stores/nav.svelte';
  import { sidebar } from '../stores/sidebar.svelte';
  import { reportError, toasts } from '../stores/toast.svelte';
  import { Keymap, shiftNumberIndexFromEvent, tabIndexFromEvent } from '../lib/keymap';
  import { toggleRailTabAndFocus } from '../lib/rail-focus';
  import {
    ctrlSlashSequence,
    SHIFT_ENTER_SEQUENCE,
    shouldSendShiftEnterSequence
  } from '../lib/terminal-input';
  import { clipboardImagePayloads, clipboardImageSources } from '../lib/clipboard-images';
  import { openDeviceBrowserUrl } from '../lib/browser-device-navigation';
  import { resolvePathLinkTarget } from '../lib/ghostty/links';
  import { terminalPresentationRedrawSizes } from '../lib/terminal-control';

  let {
    terminalId,
    sessionId,
    presented,
    focused
  }: {
    terminalId: TerminalId;
    sessionId: SessionId;
    presented: boolean;
    focused: boolean;
  } = $props();

  interface GhosttyTerminalHandle {
    focus(): void;
    fit(): boolean;
    getDimensions(): { cols: number; rows: number } | null;
    hasSelection(): boolean;
    getSelection(): string;
    getBufferText(): string;
    find(query: string, direction?: 'next' | 'previous'): boolean;
    getSelectionEndClientRect(): { right: number; bottom: number } | null;
    clearSelection(): void;
  }

  let terminal = $state.raw<GhosttyTerminalHandle | null>(null);
  let connection = $state.raw<TerminalSessionConnection | null>(null);
  let terminalState = $state<TerminalSessionState>(emptyTerminalState('', '' as SessionId));
  let surfaceReady = $state(false);
  let transitioningControl = $state(false);
  let lastAuthoritativeSize: { cols: number; rows: number } | null = null;
  let lastRedrawnFromSeq: number | null = null;
  let redrawPromise: Promise<void> | null = null;
  let chipText = $state('');
  let chipAnchor = $state<{ top: number; left: number } | null>(null);
  let chipEl: HTMLButtonElement | null = $state(null);
  let askOpen = $state(false);
  let askSelection = $state('');
  let menuHasSelection = $state(false);
  let findInput: HTMLInputElement | null = $state(null);
  let findOpen = $state(false);
  let findQuery = $state('');
  let findMatched = $state<boolean | null>(null);

  let inputLease = $derived(terminalControl.lease(terminalId));
  let ownsInput = $derived(terminalControl.owns(terminalId));
  let readOnly = $derived(Boolean(presented && inputLease && !ownsInput));
  let terminalFont = $derived({
    family: terminalFontFamily,
    size: settings.current.terminal.fontSize
  });
  let terminalTheme = $derived(terminalThemeFor(appearanceTheme.resolved));
  let ready = $derived(surfaceReady && terminalState.status.kind === 'ready');
  let loadingLabel = $derived(
    transitioningControl || (!inputLease && focused && presented)
      ? 'Taking control and preparing terminal…'
      : sessions.runtime[sessionId]?.status === 'starting'
        ? 'Starting'
        : terminalState.status.kind === 'error'
          ? 'Reconnecting terminal'
          : 'Restoring terminal'
  );

  $effect(() => {
    const id = terminalId;
    const ownerSessionId = sessionId;
    terminalState = emptyTerminalState(id, ownerSessionId);
    lastRedrawnFromSeq = null;
    redrawPromise = null;
    const attached = ipc.terminal.attachSession(
      id,
      ownerSessionId,
      (next) => {
        terminalState = next;
      },
      true
    );
    connection = attached;
    return () => {
      attached.dispose();
      if (connection === attached) connection = null;
    };
  });

  $effect(() => {
    if (!focused || !presented) return;
    void terminalControl.select(terminalId);
  });

  $effect(() => {
    if (!ownsInput) {
      lastAuthoritativeSize = null;
      return;
    }
    if (presented && surfaceReady) void prepareInteractiveTerminal(true);
  });

  $effect(() => {
    const redrawFromSeq = terminalState.status.kind === 'ready'
      && terminalState.status.truncated
      ? terminalState.fromSeq
      : null;
    if (
      redrawFromSeq === null
      || redrawFromSeq === lastRedrawnFromSeq
      || !presented
      || !surfaceReady
      || !ownsInput
    ) return;
    void prepareInteractiveTerminal(true);
  });

  $effect(() => {
    if (!focused || !presented || !ownsInput || !surfaceReady) return;
    requestAnimationFrame(() => terminal?.focus());
  });

  $effect(() => {
    if (!focused) return;
    const onSave = () => void saveBuffer().catch(reportError);
    const onCopy = () => void copyBuffer().catch(reportError);
    const onCopyMarkdown = () => void copyMarkdown().catch(reportError);
    const onRefocus = () => terminal?.focus();
    const onFind = () => openFind();
    window.addEventListener('soloe:terminal-find', onFind);
    window.addEventListener('soloe:terminal-save-buffer', onSave);
    window.addEventListener('soloe:terminal-copy-buffer', onCopy);
    window.addEventListener('soloe:terminal-copy-markdown', onCopyMarkdown);
    window.addEventListener('soloe:refocus-terminal', onRefocus);
    return () => {
      window.removeEventListener('soloe:terminal-save-buffer', onSave);
      window.removeEventListener('soloe:terminal-copy-buffer', onCopy);
      window.removeEventListener('soloe:terminal-copy-markdown', onCopyMarkdown);
      window.removeEventListener('soloe:refocus-terminal', onRefocus);
      window.removeEventListener('soloe:terminal-find', onFind);
    };
  });

  async function takeInputControl(): Promise<void> {
    if (transitioningControl || terminalControl.takingOver(terminalId)) return;
    transitioningControl = true;
    surfaceReady = false;
    try {
      const claimed = await terminalControl.takeover(terminalId);
      if (claimed) await prepareInteractiveTerminal(true);
    } finally {
      transitioningControl = false;
      surfaceReady = true;
    }
  }

  function sendTerminalInput(data: string): void {
    if (!ownsInput) return;
    void terminalControl.input(terminalId, data).catch(() => undefined);
  }

  async function sendAuthoritativeResize(cols: number, rows: number, force = false): Promise<void> {
    if (!ownsInput || cols < 1 || rows < 1) return;
    if (!force && lastAuthoritativeSize?.cols === cols && lastAuthoritativeSize.rows === rows) return;
    lastAuthoritativeSize = { cols, rows };
    try {
      await terminalControl.resize(terminalId, cols, rows);
    } catch {
      lastAuthoritativeSize = null;
    }
  }

  async function prepareInteractiveTerminal(force = false): Promise<void> {
    if (!ownsInput || !presented || !terminal) return;
    terminal.fit();
    const dimensions = terminal.getDimensions();
    if (!dimensions) return;
    const redrawFromSeq = terminalState.status.kind === 'ready'
      && terminalState.status.truncated
      ? terminalState.fromSeq
      : null;
    if (redrawFromSeq !== null && lastRedrawnFromSeq !== redrawFromSeq) {
      lastRedrawnFromSeq = redrawFromSeq;
      const redraw = (async () => {
        for (const size of terminalPresentationRedrawSizes(dimensions)) {
          await terminalControl.resize(terminalId, size.cols, size.rows, { force: true });
        }
      })();
      redrawPromise = redraw;
      try {
        await redraw;
        lastAuthoritativeSize = dimensions;
      } catch {
        if (lastRedrawnFromSeq === redrawFromSeq) lastRedrawnFromSeq = null;
        lastAuthoritativeSize = null;
      } finally {
        if (redrawPromise === redraw) redrawPromise = null;
      }
    } else if (redrawPromise) {
      await redrawPromise;
    } else {
      await sendAuthoritativeResize(dimensions.cols, dimensions.rows, force);
    }
    if (focused) terminal.focus();
  }

  function handleSurfaceReady(): void {
    surfaceReady = true;
    if (ownsInput) void prepareInteractiveTerminal(true);
  }

  function beforeTerminalKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true;
    const ctrlSlash = ctrlSlashSequence(event);
    if (ctrlSlash !== null) {
      event.preventDefault();
      sendTerminalInput(ctrlSlash);
      return false;
    }
    if (tabIndexFromEvent(event) !== null || shiftNumberIndexFromEvent(event) !== null) return false;
    if (Keymap.deleteSelectedSession.match(event)) {
      event.preventDefault();
      void nav.closeActive();
      return false;
    }
    const railBindings = [
      [Keymap.toggleNotesRail, 'notes'],
      [Keymap.toggleDiffRail, 'diff'],
      [Keymap.toggleFilesRail, 'files'],
      [Keymap.toggleFeatureRail, 'feature'],
      [Keymap.toggleBrowserRail, 'browser']
    ] as const;
    for (const [binding, rail] of railBindings) {
      if (!binding.match(event)) continue;
      event.preventDefault();
      void toggleRailTabAndFocus(rail);
      return false;
    }
    if (Keymap.toggleSidebar.match(event)) {
      event.preventDefault();
      sidebar.toggle();
      return false;
    }
    for (const binding of Object.values(Keymap)) {
      if (binding.match(event)) return false;
    }
    if (shouldSendShiftEnterSequence(event)) {
      event.preventDefault();
      sendTerminalInput(SHIFT_ENTER_SEQUENCE);
      return false;
    }
    return true;
  }

  function pasteImages(event: ClipboardEvent): boolean {
    const lease = inputLease;
    if (!ownsInput || !lease) return false;
    const session = sessions.sessions.find((item) => item.id === sessionId);
    if (!session || !effectiveAgentProvider(session)) return false;
    const sources = clipboardImageSources(event.clipboardData);
    if (sources.length === 0) return false;
    const control = terminalControlProof(lease);
    void clipboardImagePayloads(sources)
      .then((images) =>
        ipc.files.pasteImagesIntoTerminal({
          terminalId,
          sessionId,
          images,
          control
        })
      )
      .catch(reportError);
    return true;
  }

  function handleSelectionChange(): void {
    requestAnimationFrame(() => {
      const text = terminal?.getSelection() ?? '';
      const rect = terminal?.getSelectionEndClientRect();
      if (!text || !rect) return;
      chipText = text;
      chipAnchor = {
        top: Math.min(window.innerHeight - 36, rect.bottom + 8),
        left: Math.max(8, Math.min(window.innerWidth - 120, rect.right - 112))
      };
    });
  }

  function openFind(): void {
    findOpen = true;
    requestAnimationFrame(() => findInput?.focus());
  }

  function find(direction: 'next' | 'previous' = 'next'): void {
    findMatched = findQuery.length > 0 ? (terminal?.find(findQuery, direction) ?? false) : null;
  }

  function clearSelectionChip(): void {
    if (askOpen) return;
    chipText = '';
    chipAnchor = null;
  }

  function openAskFromChip(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (!chipText) return;
    askSelection = chipText;
    askOpen = true;
  }

  function onAskOpenChange(open: boolean): void {
    askOpen = open;
    if (!open) {
      askSelection = '';
      terminal?.focus();
    }
  }

  function onMenuOpenChange(open: boolean): void {
    if (open) menuHasSelection = terminal?.hasSelection() ?? false;
  }

  function ctxAskAgent(): void {
    const selection = terminal?.getSelection() ?? '';
    if (!selection) return;
    askSelection = selection;
    askOpen = true;
  }

  async function ctxCopy(): Promise<void> {
    const selection = terminal?.getSelection() ?? '';
    if (!selection) return;
    await navigator.clipboard.writeText(selection);
    terminal?.clearSelection();
  }

  function activateLink(text: string): void {
    if (/^https?:\/\//i.test(text)) {
      const deviceId = deviceSessions.localDevice?.deviceId;
      if (!deviceId) {
        reportError(new Error('The local Device identity is unavailable.'));
        return;
      }
      void openDeviceBrowserUrl(text, deviceId).catch(reportError);
      return;
    }
    const session = sessions.sessions.find((item) => item.id === sessionId);
    const target = resolvePathLinkTarget(text, session?.cwd ?? '.');
    void ipc.system.openPath(target).catch(reportError);
  }

  async function bufferText(): Promise<string> {
    if (terminal) return terminal.getBufferText();
    return (await ipc.terminal.historySnapshot(terminalId))?.data ?? '';
  }

  async function saveBuffer(): Promise<void> {
    await ipc.system.saveText({ defaultPath: `${terminalId}.log`, content: await bufferText() });
  }

  async function copyBuffer(): Promise<void> {
    await navigator.clipboard.writeText(await bufferText());
    toasts.push('Copied terminal buffer', 'info');
  }

  async function copyMarkdown(): Promise<void> {
    const session = sessions.sessions.find((item) => item.id === sessionId);
    const header = session
      ? `# ${session.name || session.id}\n\n- cwd: ${session.cwd}\n- launch: ${launchKind(session)}\n- run mode: ${session.runMode}\n\n`
      : `# ${sessionId}\n\n`;
    await navigator.clipboard.writeText(`${header}\`\`\`text\n${await bufferText()}\`\`\`\n`);
    toasts.push('Copied session as Markdown', 'info');
  }

  function emptyTerminalState(id: TerminalId, ownerSessionId: SessionId): TerminalSessionState {
    return {
      terminalId: id,
      sessionId: ownerSessionId,
      reset: {
        generation: 0,
        data: '',
        replay: { cols: 1, rows: 1, resizes: [] },
        fromSeq: 1,
        toSeq: 0
      },
      tail: [],
      fromSeq: 1,
      toSeq: 0,
      cols: 1,
      rows: 1,
      byteLength: 0,
      status: { kind: 'idle' }
    };
  }
</script>

<div class="relative flex h-full w-full min-w-0 flex-col bg-[var(--terminal-background)]">
  {#if readOnly}
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
  {/if}

  <div class="relative min-h-0 flex-1" role="presentation" onpointerdown={clearSelectionChip}>
    {#if findOpen && focused}
      <div class="absolute top-2.5 right-4 z-30 flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg">
        <Input
          bind:ref={findInput}
          bind:value={findQuery}
          oninput={() => find('next')}
          onkeydown={(event) => {
            if (event.key === 'Escape') findOpen = false;
            if (event.key === 'Enter') find(event.shiftKey ? 'previous' : 'next');
          }}
          placeholder="Find"
          aria-label="Find in terminal"
          aria-invalid={findMatched === false}
          class="h-7 w-44 text-xs"
        />
        <Button variant="ghost" size="xs" onclick={() => find('previous')}>Prev</Button>
        <Button variant="ghost" size="xs" onclick={() => find('next')}>Next</Button>
        <Button variant="ghost" size="icon-xs" onclick={() => (findOpen = false)} aria-label="Close find">
          <X />
        </Button>
      </div>
    {/if}
    {#if (!ready && !readOnly) || transitioningControl}
      <div class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[var(--terminal-background)]">
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

    <ContextMenu.Root onOpenChange={onMenuOpenChange}>
      <ContextMenu.Trigger>
        {#snippet child({ props })}
          <div {...props} class="h-full w-full min-w-0 overflow-hidden">
            <GhosttyTerminal
              bind:this={terminal}
              state={terminalState}
              {presented}
              {focused}
              interactive={presented && ownsInput}
              theme={terminalTheme}
              font={terminalFont}
              onData={sendTerminalInput}
              onResize={(cols, rows) => void sendAuthoritativeResize(cols, rows)}
              beforeKey={beforeTerminalKey}
              onPaste={pasteImages}
              onSelectionChange={handleSelectionChange}
              onLinkActivate={activateLink}
              onContextMenu={() => (menuHasSelection = terminal?.hasSelection() ?? false)}
              onResync={() => void connection?.resync()}
              onReady={handleSurfaceReady}
            />
          </div>
        {/snippet}
      </ContextMenu.Trigger>
      <ContextMenu.Content class="w-44">
        <ContextMenu.Item disabled={!menuHasSelection} onclick={ctxAskAgent}>
          <MessageSquarePlus data-icon="inline-start" />
          Ask Agent
        </ContextMenu.Item>
        <ContextMenu.Item disabled={!menuHasSelection} onclick={() => void ctxCopy()}>
          <Copy data-icon="inline-start" />
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
    class="fixed z-50 flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 font-sans text-[11px] text-popover-foreground shadow-md hover:bg-accent hover:text-accent-foreground"
    style:top="{chipAnchor?.top ?? 0}px"
    style:left="{chipAnchor?.left ?? 0}px"
    style:visibility={chipAnchor ? 'visible' : 'hidden'}
    onmousedown={openAskFromChip}
    aria-label="Ask Agent about selection"
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
