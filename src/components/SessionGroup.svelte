<script lang="ts">
  import type { Session, SessionKind } from '@shared/types/sessions.js';
  import { modal } from '../stores/modal.svelte';
  import SessionItem from './SessionItem.svelte';
  import KindIcon from './KindIcon.svelte';

  let {
    title,
    items,
    kind
  }: { title: string; items: Session[]; kind: SessionKind } = $props();
</script>

<section>
  <header>
    <div class="title">
      <KindIcon {kind} size={12} />
      <h3>{title}</h3>
    </div>
    <button class="add" title="New {title} session" onclick={() => modal.openNew(kind)}>+</button>
  </header>
  {#if items.length === 0}
    <p class="empty">No sessions</p>
  {:else}
    <div class="list">
      {#each items as session (session.id)}
        <SessionItem {session} />
      {/each}
    </div>
  {/if}
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 4px 2px 6px;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  h3 {
    margin: 0;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    font-weight: 500;
  }
  .add {
    background: transparent;
    border: 1px solid transparent;
    color: var(--muted);
    padding: 1px 6px;
    font-size: 14px;
    line-height: 1;
    border-radius: var(--radius-sm);
  }
  .add:hover {
    color: var(--accent);
    border-color: var(--border);
    background: var(--bg-elev-2);
  }
  .empty {
    margin: 0;
    padding: 4px 10px;
    color: var(--muted-2);
    font-size: 11px;
    font-style: italic;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
</style>
