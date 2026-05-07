<script lang="ts" module>
  import type { Session, AgentRuntimeProvider } from '@shared/types/sessions.js';
  import type { ModelCatalogEntry } from '@shared/types/settings.js';
  import { MODEL_CATALOG } from '@shared/types/settings.js';
  import { commentAgents, type CommentAgent } from '../../stores/comment-agents.svelte';
  import { sessions } from '../../stores/sessions.svelte';

  export type MentionItem =
    | { kind: 'agent'; agent: CommentAgent; label: string; provider: AgentRuntimeProvider; model?: string }
    | { kind: 'session'; session: Session; label: string; provider: AgentRuntimeProvider }
    | { kind: 'new-provider'; provider: AgentRuntimeProvider; label: string }
    | { kind: 'new-model'; provider: AgentRuntimeProvider; model: string; label: string };

  function modelProviderToRuntime(provider: ModelCatalogEntry['provider']): AgentRuntimeProvider {
    return provider === 'claude' ? 'claude_code' : 'codex';
  }

  // Builds the candidate list for the @-mention picker, in the order they
  // should display. Filters by case-insensitive substring on the visible
  // label. The list always carries at least one synthetic "new …" item so
  // the user can spawn an agent even with an empty cwd.
  export function buildMentionItems(cwd: string, query: string): MentionItem[] {
    const items: MentionItem[] = [];

    // 1) Already-named agents for this worktree.
    for (const agent of commentAgents.forCwd(cwd)) {
      const item: MentionItem = {
        kind: 'agent',
        agent,
        label: agent.name,
        provider: agent.provider,
        ...(agent.model ? { model: agent.model } : {})
      };
      items.push(item);
    }

    // 2) Active sessions whose cwd matches this worktree, that aren't already
    // wrapped in a CommentAgent above (compared by spawnedSessionId).
    const wrappedIds = new Set(
      commentAgents.forCwd(cwd).map((a) => a.spawnedSessionId).filter((v): v is string => Boolean(v))
    );
    for (const s of sessions.sessions) {
      if (s.cwd !== cwd) continue;
      if (wrappedIds.has(s.id)) continue;
      const provider: AgentRuntimeProvider | null =
        s.launch.type === 'agent' ? s.launch.provider : null;
      if (!provider) continue;
      items.push({ kind: 'session', session: s, label: s.name, provider });
    }

    // 3) Spawn-new entries.
    items.push({ kind: 'new-provider', provider: 'claude_code', label: 'Claude' });
    items.push({ kind: 'new-provider', provider: 'codex', label: 'Codex' });

    // 4) Specific models from the catalog.
    for (const entry of MODEL_CATALOG) {
      items.push({
        kind: 'new-model',
        provider: modelProviderToRuntime(entry.provider),
        model: entry.id,
        label: entry.label
      });
    }

    if (!query) return items;
    const q = query.toLowerCase();
    return items.filter((i) => i.label.toLowerCase().includes(q));
  }
</script>

<script lang="ts">
  import KindIcon from '../KindIcon.svelte';
  import { Plus } from '@lucide/svelte';

  interface Props {
    items: MentionItem[];
    activeIndex: number;
    onSelect: (index: number) => void;
    onHover: (index: number) => void;
  }

  let { items, activeIndex, onSelect, onHover }: Props = $props();
</script>

{#if items.length > 0}
  <div
    class="absolute right-0 bottom-full left-0 z-[2] mb-1 max-h-56 overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    role="listbox"
  >
    {#each items as item, idx (item.kind + idx + item.label)}
      {@const active = idx === activeIndex}
      {@const sectionBreak =
        idx > 0 &&
        items[idx - 1] !== undefined &&
        items[idx - 1]!.kind !== item.kind &&
        // Keep new-provider and new-model visually grouped under one rule
        !(items[idx - 1]!.kind === 'new-provider' && item.kind === 'new-model')}
      {#if sectionBreak}
        <div class="my-1 border-t border-border/60"></div>
      {/if}
      <button
        type="button"
        class={[
          'flex w-full items-center gap-2 px-2 py-1 text-left text-xs',
          active ? 'bg-muted text-foreground' : 'hover:bg-muted/60'
        ]}
        role="option"
        aria-selected={active}
        onmousedown={(e) => {
          e.preventDefault();
          onSelect(idx);
        }}
        onmouseenter={() => onHover(idx)}
      >
        <KindIcon kind={item.provider} size={12} />
        <span class="min-w-0 grow truncate">{item.label}</span>
        {#if item.kind === 'session'}
          <span class="shrink-0 text-[9px] tracking-wide text-muted-foreground uppercase">running</span>
        {:else if item.kind === 'new-provider'}
          <span class="inline-flex shrink-0 items-center gap-0.5 text-[9px] tracking-wide text-muted-foreground uppercase">
            <Plus class="size-2.5" /> new
          </span>
        {:else if item.kind === 'new-model'}
          <span class="inline-flex shrink-0 items-center gap-0.5 text-[9px] tracking-wide text-muted-foreground uppercase">
            <Plus class="size-2.5" /> new
          </span>
        {/if}
      </button>
    {/each}
  </div>
{/if}
