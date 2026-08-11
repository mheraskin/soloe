<script lang="ts">
  import { onMount } from 'svelte';
  import { ipc } from '../../lib/ipc';
  import { settings } from '../../stores/settings.svelte';
  import { platform } from '../../stores/platform.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import type { AgentIntegrationStatus } from '@shared/types/ipc.js';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
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

  async function setAutoRefresh(value: boolean): Promise<void> {
    try {
      await settings.update({ integrations: { autoRefreshMcpUrl: value } });
    } catch (e) {
      reportError(e);
    }
  }

  async function setAllowClaudeHeadless(value: boolean): Promise<void> {
    try {
      await settings.update({ integrations: { allowClaudeHeadless: value } });
    } catch (e) {
      reportError(e);
    }
  }

  onMount(() => {
    void refresh();
    const off = ipc.agentIntegration.onChange((s) => {
      status = s;
    });
    const offReconnect = ipc.connection.onReconnect(() => {
      void refresh();
    });
    return () => {
      off();
      offReconnect();
    };
  });
</script>

<div class="flex flex-col gap-3">
  <p class="m-0 text-[11px] text-muted-foreground">
    Hooks let Soloe bind Claude and Codex sessions to its tabs for correct resume. Use the button
    below to install everywhere, or manage each environment individually.
  </p>

  {#if needsSetup}
    <div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-100">
      Hooks are missing or out of date on at least one environment.
    </div>
  {/if}

  {#if status}
    <AgentIntegrationGrid {status} onChange={(next) => (status = next)} />
  {/if}

  {#if platform.current.supportsWsl}
  <div class="flex flex-col gap-1.5 rounded-md border border-border p-2.5">
    <div class="flex items-center gap-2">
      <Checkbox
        id="auto-refresh-mcp-url"
        checked={settings.current.integrations.autoRefreshMcpUrl}
        onCheckedChange={(v) => setAutoRefresh(v === true)}
      />
      <Label for="auto-refresh-mcp-url" class="text-sm text-foreground">
        Auto-refresh MCP URL on app start
      </Label>
    </div>
    <p class="m-0 text-[11px] text-muted-foreground">
      WSL's <code>host.wsl.internal</code> address can change between reboots. When enabled, Soloe
      probes each connected environment on launch and rewrites the agent config files if the URL
      drifted. Turn this off and you'll need to click <b>Update setup</b> manually whenever the
      bridge URL changes.
    </p>
  </div>
  {/if}

  <div class="flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
    <div class="flex items-center gap-2">
      <Checkbox
        id="allow-claude-headless"
        checked={settings.current.integrations.allowClaudeHeadless}
        onCheckedChange={(v) => setAllowClaudeHeadless(v === true)}
      />
      <Label for="allow-claude-headless" class="text-sm text-foreground">
        Allow Claude for Soloe-dispatched tasks
      </Label>
    </div>
    <p class="m-0 text-[11px] text-amber-200/90">
      <b>Warning:</b> Soloe-dispatched tasks (worktree overviews, background summaries) spawn
      <code>claude -p</code>, which may be metered separately from your interactive Claude Code
      subscription and can incur API charges. Off by default. When off, Claude is hidden from
      background-task model pickers and only Codex is used.
    </p>
  </div>
</div>
