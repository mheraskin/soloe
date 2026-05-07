<script lang="ts">
  import type { DiffHunk } from '@shared/types/git.js';

  interface Props {
    hunk: DiffHunk;
    // 'unified' renders one column; 'split' renders side-by-side using
    // the same line array with paired alignment derived inline.
    mode: 'unified' | 'split';
    // Width hint for the gutter (in characters). Larger files need more
    // room; we let the parent compute this from the max line number.
    gutterWidth: number;
  }

  let { hunk, mode, gutterWidth }: Props = $props();

  // Pair add/remove lines into rows for the split view. A bare delete
  // pairs with empty new-side; a bare add pairs with empty old-side; a
  // delete immediately followed by an add is treated as a paired edit.
  type PairRow =
    | { kind: 'context'; old: number | null; new: number | null; text: string }
    | {
        kind: 'pair';
        old: number | null;
        new: number | null;
        oldText: string | null;
        newText: string | null;
      }
    | { kind: 'meta'; text: string };

  let pairRows = $derived.by<PairRow[]>(() => {
    const rows: PairRow[] = [];
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.kind === 'context') {
        rows.push({
          kind: 'context',
          old: line.oldLine,
          new: line.newLine,
          text: line.text
        });
        i += 1;
        continue;
      }
      if (line.kind === 'meta') {
        rows.push({ kind: 'meta', text: line.text });
        i += 1;
        continue;
      }
      // Greedy: collect a run of removes then a run of adds.
      const removes: typeof lines = [];
      while (i < lines.length && lines[i]!.kind === 'remove') {
        removes.push(lines[i]!);
        i += 1;
      }
      const adds: typeof lines = [];
      while (i < lines.length && lines[i]!.kind === 'add') {
        adds.push(lines[i]!);
        i += 1;
      }
      const max = Math.max(removes.length, adds.length, 1);
      for (let k = 0; k < max; k++) {
        const r = removes[k];
        const a = adds[k];
        rows.push({
          kind: 'pair',
          old: r?.oldLine ?? null,
          new: a?.newLine ?? null,
          oldText: r ? r.text : null,
          newText: a ? a.text : null
        });
      }
    }
    return rows;
  });

  function gutterStyle(width: number): string {
    return `width: ${Math.max(3, width)}ch;`;
  }
</script>

<section class="border-t border-border first:border-t-0">
  <header
    class="sticky top-0 z-[1] flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
    title="@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@"
  >
    <span class="text-muted-foreground/70">
      {hunk.oldStart},{hunk.oldCount} → {hunk.newStart},{hunk.newCount}
    </span>
    {#if hunk.header}
      <span class="truncate text-muted-foreground/80">{hunk.header}</span>
    {/if}
  </header>

  <div class="flex flex-col font-mono text-[11px] leading-[1.55]">
    {#if mode === 'unified'}
      {#each hunk.lines as line, idx (idx)}
        <div
          class={[
            'flex min-h-[1.45em] gap-0',
            line.kind === 'add' && 'bg-emerald-500/10 dark:bg-emerald-500/12',
            line.kind === 'remove' && 'bg-rose-500/10 dark:bg-rose-500/12',
            line.kind === 'meta' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          ]}
        >
          <span
            class="shrink-0 select-none border-r border-border/60 px-1.5 text-right text-muted-foreground/70"
            style={gutterStyle(gutterWidth)}
          >
            {line.oldLine ?? ''}
          </span>
          <span
            class="shrink-0 select-none border-r border-border/60 px-1.5 text-right text-muted-foreground/70"
            style={gutterStyle(gutterWidth)}
          >
            {line.newLine ?? ''}
          </span>
          <span
            class={[
              'w-5 shrink-0 select-none pl-1 text-center',
              line.kind === 'add' && 'text-emerald-600 dark:text-emerald-400',
              line.kind === 'remove' && 'text-rose-600 dark:text-rose-400',
              line.kind === 'meta' && 'text-amber-600 dark:text-amber-400'
            ]}
          >
            {#if line.kind === 'add'}+{:else if line.kind === 'remove'}−{:else if line.kind === 'meta'}~{:else}&nbsp;{/if}
          </span>
          <span class="min-w-0 grow whitespace-pre-wrap break-all px-1">{line.text || ' '}</span>
        </div>
      {/each}
    {:else}
      {#each pairRows as row, idx (idx)}
        {#if row.kind === 'meta'}
          <div class="flex bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
            <span class="whitespace-pre-wrap">{row.text}</span>
          </div>
        {:else}
          <div class="grid grid-cols-2 gap-px bg-border/50">
            <!-- Old side -->
            <div
              class={[
                'flex min-h-[1.45em] bg-background',
                row.kind === 'pair' && row.oldText !== null && 'bg-rose-500/10 dark:bg-rose-500/12'
              ]}
            >
              <span
                class="shrink-0 select-none border-r border-border/60 px-1.5 text-right text-muted-foreground/70"
                style={gutterStyle(gutterWidth)}
              >
                {row.old ?? ''}
              </span>
              <span class="min-w-0 grow whitespace-pre-wrap break-all px-1.5">
                {#if row.kind === 'context'}
                  {row.text || ' '}
                {:else if row.oldText !== null}
                  {row.oldText || ' '}
                {/if}
              </span>
            </div>
            <!-- New side -->
            <div
              class={[
                'flex min-h-[1.45em] bg-background',
                row.kind === 'pair' && row.newText !== null && 'bg-emerald-500/10 dark:bg-emerald-500/12'
              ]}
            >
              <span
                class="shrink-0 select-none border-r border-border/60 px-1.5 text-right text-muted-foreground/70"
                style={gutterStyle(gutterWidth)}
              >
                {row.new ?? ''}
              </span>
              <span class="min-w-0 grow whitespace-pre-wrap break-all px-1.5">
                {#if row.kind === 'context'}
                  {row.text || ' '}
                {:else if row.newText !== null}
                  {row.newText || ' '}
                {/if}
              </span>
            </div>
          </div>
        {/if}
      {/each}
    {/if}
  </div>
</section>
