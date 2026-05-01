<script lang="ts">
  import { AlertTriangle } from 'lucide-svelte';
  import { confirmStore } from '../stores/confirm.svelte';

  function onKey(e: KeyboardEvent) {
    if (!confirmStore.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      confirmStore.cancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      confirmStore.confirm();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if confirmStore.open}
  <div class="backdrop" onclick={() => confirmStore.cancel()} role="presentation"></div>
  <div class="dialog" role="alertdialog" aria-modal="true" aria-label={confirmStore.title || 'Confirm'}>
    <div class="head">
      {#if confirmStore.tone === 'danger'}
        <span class="tone-icon danger"><AlertTriangle size={18} /></span>
      {/if}
      {#if confirmStore.title}
        <h2>{confirmStore.title}</h2>
      {/if}
    </div>
    <p class="message">{confirmStore.message}</p>
    <footer>
      <button type="button" onclick={() => confirmStore.cancel()}>{confirmStore.cancelLabel}</button>
      <button
        type="button"
        class="primary"
        class:danger={confirmStore.tone === 'danger'}
        onclick={() => confirmStore.confirm()}
      >
        {confirmStore.confirmLabel}
      </button>
    </footer>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 100;
  }
  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 101;
    width: 380px;
    max-width: 92vw;
    background: var(--bg-elev-1);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .tone-icon.danger {
    color: var(--red);
    display: inline-flex;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 500;
  }
  .message {
    margin: 0;
    color: var(--fg);
    font-size: 13px;
    line-height: 1.45;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .primary {
    background: var(--accent-strong);
    color: var(--bg);
    border-color: var(--accent-strong);
  }
  .primary:hover:not(:disabled) {
    background: var(--accent);
    border-color: var(--accent);
  }
  .primary.danger {
    background: var(--red);
    border-color: var(--red);
    color: var(--bg);
  }
  .primary.danger:hover:not(:disabled) {
    filter: brightness(1.1);
  }
</style>
