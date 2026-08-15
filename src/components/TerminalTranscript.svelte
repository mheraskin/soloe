<script lang="ts">
  import { onMount, tick } from 'svelte';

  import type { SessionId } from '@shared/types/sessions.js';
  import type { TerminalId } from '@shared/types/terminal.js';
  import { ipc } from '../lib/ipc';
  import {
    TerminalTranscriptFollowController,
    TerminalTranscriptProjector,
    type TranscriptRecord,
    type TranscriptSpan
  } from '../lib/terminal-transcript';
  import { terminalControl } from '../stores/terminal-control.svelte';

  let {
    terminalId,
    sessionId,
    visible
  }: {
    terminalId: TerminalId;
    sessionId: SessionId;
    visible: boolean;
  } = $props();

  let scroller: HTMLDivElement | undefined = $state();
  let records = $state.raw<TranscriptRecord[]>([]);
  let projector: TerminalTranscriptProjector | null = null;
  let projectionFrame = 0;
  let presentationVisibility = (_visible: boolean): void => undefined;
  const follow = new TerminalTranscriptFollowController();
  let canonicalCols = $derived(terminalControl.lease(terminalId)?.cols ?? 120);
  let canonicalRows = $derived(terminalControl.lease(terminalId)?.rows ?? 30);

  function spanStyle(span: TranscriptSpan): string {
    return [
      span.foreground ? `color:${span.foreground}` : '',
      span.background ? `background-color:${span.background}` : '',
      span.bold ? 'font-weight:700' : '',
      span.italic ? 'font-style:italic' : '',
      span.underline ? 'text-decoration:underline' : '',
      span.strikethrough ? 'text-decoration:line-through' : '',
      span.dim ? 'opacity:.65' : ''
    ].filter(Boolean).join(';');
  }

  function scheduleProjection(): void {
    if (projectionFrame) return;
    const shouldFollow = follow.shouldFollowNewOutput();
    projectionFrame = requestAnimationFrame(async () => {
      projectionFrame = 0;
      records = projector?.records() ?? [];
      await tick();
      if (shouldFollow && scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  }

  function observeScroll(): void {
    if (!scroller) return;
    follow.observe(scroller);
  }

  onMount(() => {
    projector = new TerminalTranscriptProjector({
      cols: canonicalCols,
      rows: canonicalRows,
      scrollback: 5_000
    });
    const presentation = ipc.terminal.attachPresentation(
      terminalId,
      sessionId,
      {
        write: async (data) => {
          await projector?.write(data);
          scheduleProjection();
        },
        replace: async (data) => {
          await projector?.reset(data);
          scheduleProjection();
        }
      },
      visible
    );
    presentationVisibility = (nextVisible) => presentation.setVisible(nextVisible);
    return () => {
      presentationVisibility = () => undefined;
      presentation.dispose();
      if (projectionFrame) cancelAnimationFrame(projectionFrame);
      projector?.dispose();
      projector = null;
    };
  });

  $effect(() => {
    projector?.resize(canonicalCols, canonicalRows);
    scheduleProjection();
  });

  $effect(() => {
    presentationVisibility(visible);
  });

</script>

<div
  bind:this={scroller}
  class="terminal-transcript h-full w-full overflow-y-auto overflow-x-hidden bg-[#0f0f10] px-4 py-3 font-mono text-xs leading-5 text-[#e5e5e5] select-text"
  onscroll={observeScroll}
  data-terminal-transcript
>
  {#each records as record (record.id)}
    <div class:opacity-90={record.transient} class="transcript-line min-h-5">
      {#each record.spans as span}
        <span style={spanStyle(span)}>{span.text}</span>
      {/each}
    </div>
  {/each}
</div>

<style>
  .transcript-line {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
</style>
