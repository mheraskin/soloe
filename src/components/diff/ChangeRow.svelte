<script lang="ts">
  import { Plus, Minus } from '@lucide/svelte';
  import type { WorkingChange } from '@shared/types/git.js';

  interface Props {
    change: WorkingChange;
    selected: boolean;
    pending?: boolean;
    onpick: () => void;
    onstage?: () => void;
    onunstage?: () => void;
  }

  let { change, selected, pending = false, onpick, onstage, onunstage }: Props = $props();

  // Single-letter glyph chosen for compactness in the narrow rail. Pairs
  // visually with the colour to disambiguate at small sizes.
  const KIND_LABEL: Record<WorkingChange['kind'], string> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
    untracked: 'U'
  };

  const KIND_TONE: Record<WorkingChange['kind'], string> = {
    added: 'text-emerald-500 bg-emerald-500/15',
    modified: 'text-amber-500 bg-amber-500/15',
    deleted: 'text-rose-500 bg-rose-500/15',
    renamed: 'text-sky-500 bg-sky-500/15',
    copied: 'text-violet-500 bg-violet-500/15',
    untracked: 'text-emerald-400 bg-emerald-500/10'
  };

  let displayName = $derived.by<string>(() => {
    if (change.fromPath && change.fromPath !== change.path) {
      // Show the destination file name, but include a small breadcrumb of
      // the source so renames are obvious without expanding.
      return change.path;
    }
    return change.path;
  });

  let displayDir = $derived.by<string>(() => {
    const slash = change.path.lastIndexOf('/');
    return slash > 0 ? change.path.slice(0, slash) : '';
  });

  let basename = $derived.by<string>(() => {
    const slash = displayName.lastIndexOf('/');
    return slash >= 0 ? displayName.slice(slash + 1) : displayName;
  });
</script>

<div
  role="button"
  tabindex="0"
  class={[
    'group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors',
    selected
      ? 'bg-muted text-foreground'
      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
  ]}
  onclick={onpick}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onpick(); } }}
  aria-current={selected ? 'true' : undefined}
  title={change.fromPath ? `${change.fromPath} → ${change.path}` : change.path}
>
  <span
    class={[
      'flex size-4 shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold',
      KIND_TONE[change.kind]
    ]}
    aria-label={change.kind}
  >
    {KIND_LABEL[change.kind]}
  </span>

  <span class="flex min-w-0 flex-1 flex-col leading-tight">
    <span class="flex items-center gap-1.5">
      <span class="truncate text-foreground">{basename}</span>
      {#if change.staged}
        {#if pending}
          <span
            class="animate-pulse rounded-sm bg-primary/15 px-1 text-[9px] tracking-wider text-primary uppercase"
            aria-live="polite"
          >
            staging…
          </span>
        {:else}
          <span class="rounded-sm bg-primary/15 px-1 text-[9px] tracking-wider text-primary uppercase">
            staged
          </span>
        {/if}
      {:else if pending}
        <span
          class="animate-pulse rounded-sm bg-muted px-1 text-[9px] tracking-wider text-muted-foreground uppercase"
          aria-live="polite"
        >
          unstaging…
        </span>
      {/if}
    </span>
    {#if displayDir}
      <span class="truncate text-[10px] text-muted-foreground/70">
        {displayDir}
      </span>
    {/if}
    {#if change.fromPath && change.fromPath !== change.path}
      <span class="truncate text-[10px] text-muted-foreground/70">
        from {change.fromPath}
      </span>
    {/if}
  </span>

  <span class="flex shrink-0 items-center gap-1">
    <span class="font-mono text-[10px]">
      {#if change.binary}
        <span class="text-muted-foreground/70">bin</span>
      {:else}
        {#if change.insertions > 0}
          <span class="text-emerald-500">+{change.insertions}</span>
        {/if}
        {#if change.deletions > 0}
          <span class="text-rose-500">−{change.deletions}</span>
        {/if}
      {/if}
    </span>
    {#if change.staged && onunstage}
      <button
        type="button"
        class="flex size-4 items-center justify-center rounded text-rose-500/70 transition-colors hover:bg-muted-foreground/20 hover:text-rose-500"
        onclick={(e) => { e.stopPropagation(); onunstage?.(); }}
        title="Unstage"
        aria-label="Unstage {change.path}"
      >
        <Minus class="size-3" />
      </button>
    {:else if !change.staged && onstage}
      <button
        type="button"
        class="flex size-4 items-center justify-center rounded text-emerald-500/70 transition-colors hover:bg-muted-foreground/20 hover:text-emerald-500"
        onclick={(e) => { e.stopPropagation(); onstage?.(); }}
        title="Stage"
        aria-label="Stage {change.path}"
      >
        <Plus class="size-3" />
      </button>
    {/if}
  </span>
</div>
