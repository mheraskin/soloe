<script lang="ts">
  import { Activity, AlertTriangle, Settings } from 'lucide-svelte';
  import type { CrashLogSummary, DiagnosticItem } from '@shared/types/diagnostics.js';
  import { diagnosticsPane } from '../stores/diagnostics-pane.svelte';
  import { settings } from '../stores/settings.svelte';
  import { ipc } from '../lib/ipc';
  import { reportError } from '../stores/toast.svelte';

  let items = $state<DiagnosticItem[]>([]);
  let crashes = $state<CrashLogSummary[]>([]);
  let loading = $state(false);

  $effect(() => {
    if (!diagnosticsPane.open) return;
    loading = true;
    Promise.all([ipc.diagnostics.list(), ipc.diagnostics.crashLogs()])
      .then(([nextItems, nextCrashes]) => {
        items = nextItems;
        crashes = nextCrashes;
      })
      .catch(reportError)
      .finally(() => {
        loading = false;
      });
  });

  function runAction(item: DiagnosticItem): void {
    if (item.action === 'settings') {
      diagnosticsPane.close();
      settings.openDrawer();
    }
  }
</script>

{#if diagnosticsPane.open}
  <div class="backdrop" onclick={() => diagnosticsPane.close()} role="presentation"></div>
  <aside class="pane" aria-label="Diagnostics">
    <header>
      <div>
        <h2>Diagnostics</h2>
        <p>{items.length} issue{items.length === 1 ? '' : 's'}</p>
      </div>
      <button onclick={() => diagnosticsPane.close()} aria-label="Close diagnostics">Close</button>
    </header>

    <div class="content">
      {#if loading}
        <p class="empty">Checking…</p>
      {:else if items.length === 0}
        <p class="empty">No issues</p>
      {:else}
        {#each items as item (item.id)}
          <div class="row">
            {#if item.severity === 'info'}
              <Activity size={16} />
            {:else}
              <span
                class="severity"
                class:warn={item.severity === 'warn'}
                class:error={item.severity === 'error'}
              >
                <AlertTriangle size={16} />
              </span>
            {/if}
            <div class="body">
              <strong>{item.message}</strong>
              {#if item.detail}<span>{item.detail}</span>{/if}
            </div>
            {#if item.action === 'settings'}
              <button class="icon" onclick={() => runAction(item)} title="Open settings" aria-label="Open settings">
                <Settings size={14} />
              </button>
            {/if}
          </div>
        {/each}
      {/if}

      {#if crashes.length > 0}
        <h3>Crash logs</h3>
        {#each crashes as crash (crash.path)}
          <div class="crash">
            <span>{crash.fileName}</span>
            <time>{new Date(crash.createdAt).toLocaleString()}</time>
          </div>
        {/each}
      {/if}
    </div>
  </aside>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 100;
  }
  .pane {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 101;
    width: min(420px, 100vw);
    background: var(--bg-elev-1);
    border-left: 1px solid var(--border-strong);
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }
  h2, h3, p {
    margin: 0;
  }
  h2 {
    font-size: 15px;
  }
  header p {
    color: var(--muted);
    font-size: 12px;
    margin-top: 2px;
  }
  .content {
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: start;
    padding: 10px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .warn {
    color: var(--amber);
  }
  .error {
    color: var(--red);
  }
  .severity {
    display: inline-flex;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .body strong {
    font-size: 12px;
  }
  .body span,
  .empty,
  .crash time {
    color: var(--muted);
    font-size: 11px;
  }
  .icon {
    padding: 4px;
    display: inline-flex;
  }
  h3 {
    margin-top: 14px;
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .crash {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 10px;
    background: var(--bg-elev-2);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 11px;
  }
</style>
