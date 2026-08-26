<script lang="ts">
  import { untrack } from 'svelte';
  import type { GhosttyTheme } from '../lib/ghostty/core';
  import {
    GhosttyTerminalSurface,
    type GhosttyTerminalFont
  } from '../lib/ghostty/surface';
  import type { TerminalSessionState } from '../lib/terminal-session';
  import { RemoteTerminalInputBatcher } from '../lib/remote-terminal-input';

  let {
    state: terminalState,
    visible,
    focused,
    interactive = true,
    predictiveInput = false,
    theme,
    font,
    onData,
    onResize,
    beforeKey = () => true,
    onSelectionChange = () => undefined,
    onLinkActivate = () => undefined,
    onContextMenu = () => undefined,
    onReady = () => undefined
  }: {
    state: TerminalSessionState;
    visible: boolean;
    focused: boolean;
    interactive?: boolean;
    predictiveInput?: boolean;
    theme: GhosttyTheme;
    font: GhosttyTerminalFont;
    onData: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
    beforeKey?: (event: KeyboardEvent) => boolean;
    onSelectionChange?: () => void;
    onLinkActivate?: (text: string, event: MouseEvent) => void;
    onContextMenu?: (event: MouseEvent) => void;
    onReady?: () => void;
  } = $props();

  let host: HTMLDivElement | undefined = $state();
  let surface = $state.raw<GhosttyTerminalSurface | null>(null);
  let inputBatcher: RemoteTerminalInputBatcher | null = null;
  let appliedBuffer = '';

  $effect(() => {
    const mount = host;
    if (!mount || !visible) return;
    delete mount.dataset.ghosttyReady;
    let cancelled = false;
    const initialTheme = untrack(() => theme);
    const initialFont = untrack(() => font);
    const batcher = predictiveInput ? new RemoteTerminalInputBatcher((data) => onData(data)) : null;
    inputBatcher = batcher;

    void GhosttyTerminalSurface.create(mount, {
      theme: initialTheme,
      font: initialFont,
      predictiveInput,
      onData: (data, priority) => {
        if (!interactive) return;
        if (batcher) batcher.submit(data, priority);
        else onData(data);
      },
      onInputBoundary: () => batcher?.flush(),
      onResize: (cols, rows) => onResize(cols, rows),
      onSelectionChange: () => onSelectionChange(),
      beforeKey: (event) => interactive && beforeKey(event),
      onLinkActivate: (text, event) => onLinkActivate(text, event),
      onContextMenu: (event) => onContextMenu(event)
    }).then((created) => {
      if (cancelled) {
        created.dispose();
        return;
      }
      surface = created;
      mount.dataset.ghosttyReady = 'true';
      const current = untrack(() => terminalState);
      created.resetAndReplay(current.buffer, current.replay);
      appliedBuffer = current.buffer;
      onReady();
      if (untrack(() => focused)) created.focus();
    }).catch((error) => {
      console.error('[ghostty] failed to create terminal surface', error);
    });

    return () => {
      cancelled = true;
      const current = surface;
      surface = null;
      if (inputBatcher === batcher) inputBatcher = null;
      batcher?.dispose();
      appliedBuffer = '';
      delete mount.dataset.ghosttyReady;
      current?.dispose();
    };
  });

  $effect(() => {
    terminalState.version;
    const current = surface;
    if (!current) return;
    if (terminalState.buffer === appliedBuffer) return;
    if (terminalState.buffer.startsWith(appliedBuffer)) {
      current.write(terminalState.buffer.slice(appliedBuffer.length));
    } else {
      current.resetAndReplay(terminalState.buffer, terminalState.replay);
    }
    appliedBuffer = terminalState.buffer;
  });

  $effect(() => {
    surface?.setTheme(theme);
  });

  $effect(() => {
    const current = surface;
    if (!current) return;
    void current.setFont(font).catch((error) => {
      console.warn('[ghostty] failed to apply terminal font', error);
    });
  });

  $effect(() => {
    if (visible && focused) surface?.focus();
  });

  $effect(() => {
    if (!interactive) inputBatcher?.flush();
  });

  export function focus(): void {
    surface?.focus();
  }

  export function fit(): boolean {
    return surface?.fit() ?? false;
  }

  export function getDimensions(): { cols: number; rows: number } | null {
    return surface ? { cols: surface.cols, rows: surface.rows } : null;
  }

  export function hasSelection(): boolean {
    return surface?.hasSelection() ?? false;
  }

  export function getSelection(): string {
    return surface?.getSelection() ?? '';
  }

  export function getBufferText(): string {
    return surface?.getBufferText() ?? '';
  }

  export function find(query: string, direction: 'next' | 'previous' = 'next'): boolean {
    return surface?.find(query, direction) ?? false;
  }

  export function getSelectionEndClientRect(): { right: number; bottom: number } | null {
    return surface?.getSelectionEndClientRect() ?? null;
  }

  export function clearSelection(): void {
    surface?.clearSelection();
  }

  export function scrollToBottom(): void {
    surface?.scrollToBottom();
  }

  export function flushInput(): void {
    inputBatcher?.flush();
  }

  export function pasteFromClipboard(
    readText: () => Promise<string>,
    isCurrent?: () => boolean
  ): Promise<void> {
    return surface?.pasteFromClipboard(readText, isCurrent) ?? Promise.resolve();
  }
</script>

<div
  bind:this={host}
  class="ghostty-terminal-host relative h-full w-full min-w-0 overflow-hidden"
></div>

<style>
  .ghostty-terminal-host {
    --app-scrollbar-width: 9px;
    --app-scrollbar-thumb: color-mix(in srgb, var(--terminal-foreground) 28%, transparent);
    --app-scrollbar-thumb-hover: color-mix(in srgb, var(--terminal-foreground) 48%, transparent);
    background: var(--terminal-background);
  }

  :global(.ghostty-terminal-host canvas) {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
