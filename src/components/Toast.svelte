<script lang="ts">
  import { toasts } from '../stores/toast.svelte';
</script>

<div class="stack" aria-live="polite">
  {#each toasts.items as t (t.id)}
    <div class="toast {t.kind}" role="status">
      <span>{t.message}</span>
      <button onclick={() => toasts.dismiss(t.id)} aria-label="Dismiss">×</button>
    </div>
  {/each}
</div>

<style>
  .stack {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 360px;
  }
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    font-size: 12px;
  }
  .toast.error {
    border-color: var(--red);
  }
  .toast button {
    background: transparent;
    border: none;
    color: var(--muted);
    padding: 0 4px;
    cursor: pointer;
    font-size: 14px;
  }
  .toast button:hover { color: var(--fg); }
</style>
