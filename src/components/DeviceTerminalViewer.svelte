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
  import { clipboardImagePayloads, clipboardImageSources } from '../lib/clipboard-images';
  import { terminalPresentationRedrawSizes } from '../lib/terminal-control';
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
  }

  let terminal = $state.raw<GhosttyTerminalHandle | null>(null);
  let connection = $state.raw<TerminalSessionConnection | null>(null);
  let terminalState = $state<TerminalSessionState | null>(null);
  let surfaceReady = $state(false);
  let error = $state<string | null>(null);
  let takingControl = $state(false);
  let pageVisible = $state(document.visibilityState === 'visible');
  let lastSize: { cols: number; rows: number } | null = null;
  let lastRedrawnFromSeq: number | null = null;
  let redrawPromise: Promise<void> | null = null;

  // Shield terminal attachment effects from whole-projection replacements. The
  // multi-Device store publishes fresh projection objects for ordinary status
  // updates; those must not reset an already-ready terminal surface when the
  // underlying Device, Session, and terminal identities did not change.
  let terminalDeviceId = $derived(projection.ref.deviceId);
  let terminalSessionId = $derived(projection.ref.sessionId);
  let terminalRuntimeId = $derived(projection.runtime?.terminalId ?? null);
  let offline = $derived(
    !projection.available
    || deviceSessions.device(terminalDeviceId)?.available !== true
  );
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
  let controlledByOther = $derived(Boolean(inputLease?.lease && !ownsInput));
  let acceptsInput = $derived(offline ? !controlledByOther : ownsInput);
  let readOnly = $derived(controlledByOther);
  let ready = $derived(Boolean(surfaceReady && terminalState?.status.kind === 'ready'));
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
    lastRedrawnFromSeq = null;
    redrawPromise = null;
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
        error = next.status.kind === 'error' ? next.status.message : null;
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
    connection?.setVisible(!offline);
  });

  $effect(() => {
    const ref = terminalRef;
    if (!ref || !active || !interactive || !pageVisible || offline) return;
    void reclaimInputControl(ref);
  });

  $effect(() => {
    const redrawFromSeq = terminalState?.status.kind === 'ready'
      && terminalState.status.truncated
      ? terminalState.fromSeq
      : null;
    if (
      redrawFromSeq === null
      || redrawFromSeq === lastRedrawnFromSeq
      || !surfaceReady
      || !active
      || !interactive
      || !ownsInput
      || offline
    ) return;
    void prepareInteractive(true);
  });

  $effect(() => {
    const ref = terminalRef;
    if (!ref) return;
    return deviceSessions.onDeviceReconnect(ref.deviceId, () => {
      if (
        active
        && interactive
        && pageVisible
        && !offline
        && terminalRef?.terminalId === ref.terminalId
      ) {
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
    if (!ref || takingControl || offline) return;
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
    if (offline) return;
    const claimed = await deviceSessions.claimTerminalInputControl(ref);
    if (claimed) await prepareInteractive(true);
  }

  function sendData(data: string): void {
    const ref = terminalRef;
    if (!ref || !active || !interactive || !acceptsInput) return;
    void deviceSessions.terminalInput(ref, data).then(
      () => (error = null),
      (cause) => (error = cause instanceof Error ? cause.message : String(cause))
    );
  }

  async function resize(cols: number, rows: number, force = false): Promise<void> {
    const ref = terminalRef;
    if (
      !ref
      || !active
      || !interactive
      || !ownsInput
      || offline
      || cols < 1
      || rows < 1
    ) return;
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
    if (!terminal || !active || !interactive || !ownsInput || offline) return;
    terminal.fit();
    const dimensions = terminal.getDimensions();
    if (!dimensions) return;
    const redrawFromSeq = terminalState?.status.kind === 'ready'
      && terminalState.status.truncated
      ? terminalState.fromSeq
      : null;
    if (redrawFromSeq !== null && lastRedrawnFromSeq !== redrawFromSeq) {
      lastRedrawnFromSeq = redrawFromSeq;
      const redraw = (async () => {
        const ref = terminalRef;
        if (!ref) return;
        for (const size of terminalPresentationRedrawSizes(dimensions)) {
          await deviceSessions.terminalResize(ref, size.cols, size.rows);
        }
      })();
      redrawPromise = redraw;
      try {
        await redraw;
        lastSize = dimensions;
        error = null;
      } catch (cause) {
        if (lastRedrawnFromSeq === redrawFromSeq) lastRedrawnFromSeq = null;
        lastSize = null;
        error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        if (redrawPromise === redraw) redrawPromise = null;
      }
    } else if (redrawPromise) {
      await redrawPromise;
    } else {
      await resize(dimensions.cols, dimensions.rows, force);
    }
    if (pageVisible && !compactTouchViewport()) terminal?.focus();
  }

  function surfaceDidLoad(): void {
    surfaceReady = true;
    if (active && interactive && ownsInput) void prepareInteractive(true);
  }

  function pasteImages(event: ClipboardEvent): boolean {
    const ref = terminalRef;
    const session = projection.session;
    if (!ref || offline || !session || !effectiveAgentProvider(session)) return false;
    const sources = clipboardImageSources(event.clipboardData);
    if (sources.length === 0) return false;
    const sessionId = projection.ref.sessionId;
    void clipboardImagePayloads(sources)
      .then((images) => deviceSessions.pasteImagesIntoTerminal(ref, sessionId, images))
      .catch((cause) => {
        error = cause instanceof Error ? cause.message : String(cause);
      });
    return true;
  }

  function activateLink(text: string): void {
    if (offline || !/^https?:\/\//i.test(text)) return;
    void openDeviceBrowserUrl(text, projection.ref.deviceId).catch((cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
    });
  }

  function compactTouchViewport(): boolean {
    const matchMedia = window.matchMedia?.bind(window);
    return matchMedia?.('(max-width: 767px)').matches === true
      && matchMedia('(pointer: coarse)').matches;
  }

</script>

<section class="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--terminal-background)]">
  <SessionToolbar {projection} {onClose} readOnly={offline} />
  {#if offline || readOnly}
    <div
      role="status"
      class="flex items-center gap-2 border-b border-border bg-background/95 px-3 py-2 text-xs text-foreground"
    >
      <span class="min-w-0 flex-1 truncate">
        {offline
          ? acceptsInput
            ? 'Offline · input queued until reconnect'
            : `Offline · controlled by ${inputLease?.lease?.controllerDeviceName ?? 'another client'}`
          : `Read-only · controlled by ${inputLease?.lease?.controllerDeviceName ?? 'another client'}`}
      </span>
      {#if !offline}
        <button
          type="button"
          class="rounded border border-border px-2 py-1 font-medium hover:bg-accent disabled:opacity-50"
          disabled={takingControl || !terminalRef}
          onclick={takeInputControl}
        >Take Over</button>
      {/if}
    </div>
  {/if}
  <div class="relative min-h-0 flex-1 overflow-hidden">
    {#if terminalState}
      <GhosttyTerminal
        bind:this={terminal}
        state={terminalState}
        presented={active}
        focused={active && pageVisible}
        interactive={active && interactive && acceptsInput && pageVisible}
        {predictiveInput}
        {theme}
        {font}
        onData={sendData}
        onResize={(cols, rows) => void resize(cols, rows)}
        onPaste={pasteImages}
        onLinkActivate={activateLink}
        onResync={() => void connection?.resync()}
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
  {#if terminalState?.status.kind === 'ready' && terminalState.status.truncated}
    <div class="border-t border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[10px] text-amber-200">
      Earlier terminal output was discarded before this Device connected. The newest output remains available in the bounded replay tail.
    </div>
  {/if}
</section>
