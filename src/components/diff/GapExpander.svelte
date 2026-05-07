<script lang="ts">
  import { ChevronsUpDown, Loader2 } from '@lucide/svelte';
  import { workingDiff } from '../../stores/working-diff.svelte';

  interface Props {
    cwd: string;
    filePath: string;
    // 1-based line range in the *old* file. Since the gap is unchanged
    // content, the new-file range maps onto the same lines but with a
    // different starting offset, which we pass separately for the gutter.
    oldStart: number;
    oldEnd: number;
    newStart: number;
    gutterWidth: number;
    mode: 'unified' | 'split';
  }

  let { cwd, filePath, oldStart, oldEnd, newStart, gutterWidth, mode }: Props = $props();

  let entry = $derived(workingDiff.fileLinesEntry(cwd, filePath, oldStart, oldEnd));
  let gapSize = $derived(oldEnd - oldStart + 1);

  async function expand(): Promise<void> {
    await workingDiff.loadFileLines(cwd, filePath, oldStart, oldEnd);
  }

  function gutterStyle(width: number): string {
    return `width: ${Math.max(3, width)}ch;`;
  }
</script>

{#if entry.lines && entry.lines.length > 0}
  <div class="flex flex-col font-mono text-[11px] leading-[1.55]">
    {#if mode === 'unified'}
      {#each entry.lines as text, idx (idx)}
        <div class="flex min-h-[1.45em] gap-0">
          <span
            class="shrink-0 select-none border-r border-border/60 px-1.5 text-right text-muted-foreground/70"
            style={gutterStyle(gutterWidth)}
          >
            {oldStart + idx}
          </span>
          <span
            class="shrink-0 select-none border-r border-border/60 px-1.5 text-right text-muted-foreground/70"
            style={gutterStyle(gutterWidth)}
          >
            {newStart + idx}
          </span>
          <span class="w-5 shrink-0 select-none pl-1 text-center">&nbsp;</span>
          <span class="min-w-0 grow whitespace-pre-wrap break-all px-1">{text || ' '}</span>
        </div>
      {/each}
    {:else}
      {#each entry.lines as text, idx (idx)}
        <div class="grid grid-cols-2 gap-px bg-border/50">
          <div class="flex min-h-[1.45em] bg-background">
            <span
              class="shrink-0 select-none border-r border-border/60 px-1.5 text-right text-muted-foreground/70"
              style={gutterStyle(gutterWidth)}
            >
              {oldStart + idx}
            </span>
            <span class="min-w-0 grow whitespace-pre-wrap break-all px-1.5">{text || ' '}</span>
          </div>
          <div class="flex min-h-[1.45em] bg-background">
            <span
              class="shrink-0 select-none border-r border-border/60 px-1.5 text-right text-muted-foreground/70"
              style={gutterStyle(gutterWidth)}
            >
              {newStart + idx}
            </span>
            <span class="min-w-0 grow whitespace-pre-wrap break-all px-1.5">{text || ' '}</span>
          </div>
        </div>
      {/each}
    {/if}
  </div>
{:else}
  <button
    type="button"
    class="flex w-full items-center justify-center gap-1.5 border-y border-border bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
    onclick={() => void expand()}
    disabled={entry.loading}
    title={entry.error ?? `Show lines ${oldStart}–${oldEnd}`}
  >
    {#if entry.loading}
      <Loader2 class="size-3 animate-spin" />
    {:else}
      <ChevronsUpDown class="size-3" />
    {/if}
    <span>
      {#if entry.error}
        {entry.error}
      {:else}
        Show {gapSize} hidden line{gapSize === 1 ? '' : 's'}
      {/if}
    </span>
  </button>
{/if}
