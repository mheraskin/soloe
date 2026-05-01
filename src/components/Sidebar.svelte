<script lang="ts">
  import { sessions } from '../stores/sessions.svelte';
  import { modal } from '../stores/modal.svelte';
  import SessionGroup from './SessionGroup.svelte';
</script>

<aside>
  <div class="head">
    <button class="new" onclick={() => modal.openNew('claude_code')}>+ New session</button>
  </div>
  <div class="groups">
    <SessionGroup title="Claude" kind="claude_code" items={sessions.groups.claude} />
    <SessionGroup title="Codex" kind="codex" items={sessions.groups.codex} />
    <SessionGroup title="Terminals" kind="standard_terminal" items={sessions.groups.terminal} />
  </div>
</aside>

<style>
  aside {
    width: 260px;
    flex-shrink: 0;
    background: var(--bg-elev-1);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .head {
    padding: 10px;
    border-bottom: 1px solid var(--border);
  }
  .new {
    width: 100%;
    background: var(--bg-elev-3);
    color: var(--fg);
    border: 1px solid var(--border-strong);
  }
  .new:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .groups {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
</style>
