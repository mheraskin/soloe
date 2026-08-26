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
  import { settings } from '../stores/settings.svelte';
  import { readClipboardImages } from '../lib/clipboard-images';
  import { isClipboardPasteShortcut } from '../lib/terminal-input';
  import { openDeviceBrowserUrl } from '../lib/browser-device-navigation';
  import GhosttyTerminal from './GhosttyTerminal.svelte';
  import SessionToolbar from './SessionToolbar.svelte';

  let {
    projection,
    onClose,
    active = true,
    interactive = active
  }: {
    projection: MultiDeviceSessionView;
    onClose: () => void;
    active?: boolean;
    interactive?: boolean;
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

  // Shield terminal attachment effects from whole-projection replacements. The
  // multi-Device store publishes fresh projection objects for ordinary status
  // updates; those must not reset an already-ready terminal surface when the
  // underlying Device, Session, and terminal identities did not change.
  let terminalDeviceId = $derived(projection.ref.deviceId);
  let terminalSessionId = $derived(projection.ref.sessionId);
  let terminalRuntimeId = $derived(projection.runtime?.terminalId ?? null);
  let predictiveInput = $derived(
    deviceSessions.localDevice?.deviceId !== terminalDeviceId
  );
  let terminalRef = $derived<TerminalRef | null>(
    terminalRuntimeId
      ? { deviceId: terminalDeviceId, terminalId: terminalRuntimeId }
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
  let font = $derived({
    family: terminalFontFamily,
    size: settings.current.terminal.fontSize
  });

  $effect(() => {
    const deviceId = terminalDeviceId;
    const sessionId = terminalSessionId;
    const terminalId = terminalRuntimeId;
    if (!terminalId) {
      terminalState = null;
      error = 'This Session has no running terminal to attach.';
      return;
    }
    const ref: TerminalRef = { deviceId, terminalId };
    surfaceReady = false;
    error = null;
    let outputReady = Promise.resolve();
    const session = new TerminalHistorySession(
      terminalId,
      sessionId,
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
        onReconnect: (listener) => deviceSessions.onDeviceReconnect(deviceId, listener)
      }
    );
    const attached = session.connect(
      (next) => {
        terminalState = next;
        error = next.error;
      },
      false
    );
    connection = attached;
    return () => {
      attached.dispose();
      if (connection === attached) connection = null;
    };
  });

  $effect(() => {
    connection?.setVisible(active);
  });

  $effect(() => {
    const ref = terminalRef;
    if (!ref || !active || !interactive || !pageVisible) return;
    void reclaimInputControl(ref);
  });

  $effect(() => {
    const ref = terminalRef;
    if (!ref) return;
    return deviceSessions.onDeviceReconnect(ref.deviceId, () => {
      if (active && interactive && pageVisible && terminalRef?.terminalId === ref.terminalId) {
        void reclaimInputControl(ref);
      }
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

  async function reclaimInputControl(ref: TerminalRef): Promise<void> {
    const claimed = await deviceSessions.claimTerminalInputControl(ref);
    if (claimed) await prepareInteractive(true);
  }

  function sendData(data: string): void {
    const ref = terminalRef;
    if (!ref || !active || !interactive || !ownsInput) return;
    void deviceSessions.terminalInput(ref, data).then(
      () => (error = null),
      (cause) => (error = cause instanceof Error ? cause.message : String(cause))
    );
  }

  async function resize(cols: number, rows: number, force = false): Promise<void> {
    const ref = terminalRef;
    if (!ref || !active || !interactive || !ownsInput || cols < 1 || rows < 1) return;
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
    if (!terminal || !active || !interactive || !ownsInput) return;
    terminal.fit();
    const dimensions = terminal.getDimensions();
    if (!dimensions) return;
    await resize(dimensions.cols, dimensions.rows, force);
    if (pageVisible && !compactTouchViewport()) terminal.focus();
  }

  function surfaceDidLoad(): void {
    surfaceReady = true;
    if (active && interactive && ownsInput) void prepareInteractive(true);
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
    if (!ref || !terminal || !active || !interactive || !ownsInput) return;
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
        focused={active && pageVisible}
        interactive={active && interactive && ownsInput && pageVisible}
        {predictiveInput}
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
  {#if terminalState?.truncated}
    <div class="border-t border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[10px] text-amber-200">
      Earlier terminal output was discarded before this Device connected. New output is retained in full.
    </div>
  {/if}
</section>
