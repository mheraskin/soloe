<script lang="ts">
  import { onMount } from 'svelte';
  import { ipc } from '../../lib/ipc';
  import { reportError } from '../../stores/toast.svelte';
  import type { AgentIntegrationStatus } from '@shared/types/ipc.js';
  import AgentIntegrationGrid from '../AgentIntegrationGrid.svelte';

  let status = $state<AgentIntegrationStatus | null>(null);

  const needsSetup = $derived.by(() => {
    if (!status) return false;
    return status.hosts.some(
      (h) => h.host.available && (!h.claude.current || !h.codex.current)
    );
  });

  async function refresh() {
    try {
      status = await ipc.agentIntegration.status();
    } catch (e) {
      reportError(e);
    }
  }

  onMount(() => {
    void refresh();
    const off = ipc.agentIntegration.onChange((s) => {
      status = s;
    });
    return off;
  });
</script>

<div class="flex flex-col gap-3">
  <p class="m-0 text-[11px] text-muted-foreground">
    Toggle a checkbox to install or remove hooks for that environment. Hooks let Soloe bind Claude
    and Codex sessions to its tabs for correct resume.
  </p>

  {#if needsSetup}
    <div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-100">
      Hooks are missing or out of date on at least one environment.
    </div>
  {/if}

  {#if status}
    <AgentIntegrationGrid {status} onChange={(next) => (status = next)} />
  {/if}
</div>
