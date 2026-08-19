<script lang="ts">
  import { onMount } from 'svelte';
  import type { TerminalRef } from '@shared/types/devices.js';
  import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
  import { effectiveAgentProvider } from '@shared/types/sessions.js';
  import type { TerminalSessionState } from '../lib/terminal-session';
  import {
    TerminalHistorySession,
    type TerminalSessionConnection
  } from '../lib/terminal-session';
  import { terminalFontFamily, terminalThemeFor } from '../lib/terminal-theme';
  import { appearanceTheme } from '../stores/appearance-theme.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { readClipboardImages } from '../lib/clipboard-images';
  import { isClipboardPasteShortcut } from '../lib/terminal-input';
  import { openDeviceBrowserUrl } from '../lib/browser-device-navigation';
  import GhosttyTerminal from './GhosttyTerminal.svelte';
  import SessionToolbar from './SessionToolbar.svelte';

  let {
    projection,
    onClose
  }: {
    projection: MultiDeviceSessionView;
    onClose: () => void;
  } = $props();

  interface GhosttyTerminalHandle {
    focus(): void;
    fit(): boolean;
    getDimensions(): { cols: number; rows: number } | null;
    pasteFromClipboard(readText: () => Promise<string>, isCurrent?: () => boolean): Promise<void>;
  }

  let terminal = $state.raw<GhosttyTerminalHandle | null>(null);
  let connection = $state.raw<TerminalSessionConnection | null>(null);
  let terminalState = $state<TerminalSessionState | null>(null);
  let surfaceReady = $state(false);
  let error = $state<string | null>(null);
  let takingControl = $state(false);
  let pageVisible = $state(document.visibilityState === 'visible');
  let lastSize: { cols: number; rows: number } | null = null;

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
  let ready = $derived(Boolean(surfaceReady && terminalState?.status === 'ready'));
  let theme = $derived(terminalThemeFor(appearanceTheme.resolved));
  const font = { family: terminalFontFamily, size: 12 };

  $effect(() => {
    const ref = terminalRef;
    if (!ref) {
      terminalState = null;
      error = 'This Session has no running terminal to attach.';
      return;
    }
    surfaceReady = false;
    error = null;
    let outputReady = Promise.resolve();
    const session = new TerminalHistorySession(
      ref.terminalId,
      projection.ref.sessionId,
      {
        subscribeOutput: (listener) => {
          const attachment = deviceSessions.acquireTerminalOutput(ref, listener);
          outputReady = attachment.ready;
          return () => attachment.dispose();
        },
        historySnapshot: async () => (await deviceSessions.terminalHistory(ref)).snapshot,
        setOutputDemand: async (_terminalId, active) => {
          if (active) await outputReady;
        },
        onReconnect: (listener) => deviceSessions.onDeviceReconnect(ref.deviceId, listener)
      }
    );
    const attached = session.connect(
      (next) => {
        terminalState = next;
        error = next.error;
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
    const ref = terminalRef;
    if (!ref || !pageVisible) return;
    void deviceSessions.claimTerminalInputControl(ref).then((claimed) => {
      if (claimed) void prepareInteractive(true);
    });
  });

  onMount(() => {
    const onVisibility = () => {
      pageVisible = document.visibilityState === 'visible';
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  async function takeInputControl(): Promise<void> {
    const ref = terminalRef;
    if (!ref || takingControl) return;
    takingControl = true;
    try {
      const claimed = await deviceSessions.claimTerminalInputControl(ref, true);
      if (!claimed) throw new Error('Input control is still held by another device.');
      await prepareInteractive(true);
      error = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      takingControl = false;
    }
  }

  function sendData(data: string): void {
    const ref = terminalRef;
    if (!ref || !ownsInput) return;
    void deviceSessions.terminalInput(ref, data).then(
      () => (error = null),
      (cause) => (error = cause instanceof Error ? cause.message : String(cause))
    );
  }

  async function resize(cols: number, rows: number, force = false): Promise<void> {
    const ref = terminalRef;
    if (!ref || !ownsInput || cols < 1 || rows < 1) return;
    if (!force && lastSize?.cols === cols && lastSize.rows === rows) return;
    lastSize = { cols, rows };
    try {
      await deviceSessions.terminalResize(ref, cols, rows);
      error = null;
    } catch (cause) {
      lastSize = null;
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function prepareInteractive(force = false): Promise<void> {
    if (!terminal || !ownsInput) return;
    terminal.fit();
    const dimensions = terminal.getDimensions();
    if (!dimensions) return;
    await resize(dimensions.cols, dimensions.rows, force);
    if (pageVisible && !compactTouchViewport()) terminal.focus();
  }

  function surfaceDidLoad(): void {
    surfaceReady = true;
    if (ownsInput) void prepareInteractive(true);
  }

  function beforeKey(event: KeyboardEvent): boolean {
    if (!isClipboardPasteShortcut(event)) return true;
    event.preventDefault();
    void pasteFromClipboard().catch((cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
    });
    return false;
  }

  async function pasteFromClipboard(): Promise<void> {
    const ref = terminalRef;
    if (!ref || !terminal || !ownsInput) return;
    if (projection.session && effectiveAgentProvider(projection.session)) {
      const images = await readClipboardImages().catch(() => []);
      if (images.length > 0) {
        await deviceSessions.pasteImagesIntoTerminal(ref, projection.ref.sessionId, images);
        return;
      }
    }
    await terminal.pasteFromClipboard(
      () => navigator.clipboard.readText().catch(() => ''),
      () => ownsInput
    );
  }

  function activateLink(text: string): void {
    if (!/^https?:\/\//i.test(text)) return;
    void openDeviceBrowserUrl(text, projection.ref.deviceId).catch((cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
    });
  }

  function compactTouchViewport(): boolean {
    return window.matchMedia('(max-width: 767px)').matches
      && window.matchMedia('(pointer: coarse)').matches;
  }

</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--terminal-background)]">
  <SessionToolbar {projection} {onClose} />
  {#if readOnly}
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
  {/if}
  <div class="relative min-h-0 flex-1 overflow-hidden">
    {#if terminalState}
      <GhosttyTerminal
        bind:this={terminal}
        state={terminalState}
        visible={true}
        focused={pageVisible}
        interactive={ownsInput && pageVisible}
        {theme}
        {font}
        onData={sendData}
        onResize={(cols, rows) => void resize(cols, rows)}
        {beforeKey}
        onLinkActivate={activateLink}
        onReady={surfaceDidLoad}
      />
    {/if}
    {#if !ready || takingControl}
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
