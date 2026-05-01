<script lang="ts">
  import { X } from 'lucide-svelte';
  import { settings } from '../stores/settings.svelte';
  import PreferencesForm from './forms/PreferencesForm.svelte';

  function onKey(e: KeyboardEvent) {
    if (settings.drawerOpen && e.key === 'Escape') {
      e.preventDefault();
      settings.closeDrawer();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if settings.drawerOpen}
  <div class="backdrop" onclick={() => settings.closeDrawer()} role="presentation"></div>
  <div class="drawer" role="dialog" aria-modal="true" aria-label="Settings">
    <header>
      <h2>Settings</h2>
      <button class="close" onclick={() => settings.closeDrawer()} aria-label="Close settings">
        <X size={16} />
      </button>
    </header>
    <div class="body">
      <PreferencesForm />
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 100;
  }
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 400px;
    max-width: 92vw;
    background: var(--bg-elev-1);
    border-left: 1px solid var(--border-strong);
    box-shadow: -8px 0 32px rgba(0, 0, 0, 0.5);
    z-index: 101;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  header h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 500;
  }
  .close {
    background: transparent;
    border: none;
    color: var(--muted);
    padding: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
  }
  .close:hover { color: var(--fg); }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 0 16px 16px;
  }
</style>
