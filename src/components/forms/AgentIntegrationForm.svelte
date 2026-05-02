<script lang="ts">
  import { onMount } from 'svelte';
  import { ipc } from '../../lib/ipc';
  import { reportError } from '../../stores/toast.svelte';
  import { projects } from '../../stores/projects.svelte';
  import { nav } from '../../stores/nav.svelte';
  import type {
    AgentIntegrationClaudeScope,
    AgentIntegrationStatus,
    AgentIntegrationTargetStatus
  } from '@shared/types/ipc.js';
  import { Button } from '$lib/components/ui/button';
  import { Label } from '$lib/components/ui/label';
  import { RadioGroup, RadioGroupItem } from '$lib/components/ui/radio-group';

  let status = $state<AgentIntegrationStatus | null>(null);
  let scope = $state<AgentIntegrationClaudeScope>('user');
  let claudeBusy = $state(false);
  let codexBusy = $state(false);

  const activeProject = $derived(projects.get(nav.activeProjectId));
  const projectPath = $derived(activeProject?.path);

  async function refresh() {
    try {
      status = await ipc.agentIntegration.status(projectPath);
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

  $effect(() => {
    void projectPath;
    void refresh();
  });

  async function installClaude() {
    if (claudeBusy) return;
    if ((effectiveScope === 'project' || effectiveScope === 'project_local') && !projectPath) {
      reportError(new Error('Open a project first to install per-project hooks'));
      return;
    }
    claudeBusy = true;
    try {
      status = await ipc.agentIntegration.installClaude({
        scope: effectiveScope,
        projectPath
      });
    } catch (e) {
      reportError(e);
    } finally {
      claudeBusy = false;
    }
  }

  async function uninstallClaude() {
    if (claudeBusy) return;
    claudeBusy = true;
    try {
      status = await ipc.agentIntegration.uninstallClaude({
        scope: effectiveScope,
        projectPath
      });
    } catch (e) {
      reportError(e);
    } finally {
      claudeBusy = false;
    }
  }

  async function installCodex() {
    if (codexBusy) return;
    codexBusy = true;
    try {
      status = await ipc.agentIntegration.installCodex();
    } catch (e) {
      reportError(e);
    } finally {
      codexBusy = false;
    }
  }

  async function uninstallCodex() {
    if (codexBusy) return;
    codexBusy = true;
    try {
      status = await ipc.agentIntegration.uninstallCodex();
    } catch (e) {
      reportError(e);
    } finally {
      codexBusy = false;
    }
  }

  const effectiveScope = $derived<AgentIntegrationClaudeScope>(
    !projectPath && (scope === 'project' || scope === 'project_local') ? 'user' : scope
  );

  const claudeConnected = $derived.by(() => {
    return Boolean(claudeScopeStatus?.current);
  });

  const claudeScopeStatus = $derived.by<AgentIntegrationTargetStatus | null>(() => {
    if (!status) return null;
    if (effectiveScope === 'user') return status.claude.user;
    if (effectiveScope === 'project') return status.claude.project;
    return status.claude.projectLocal;
  });

  function statusLabel(item: AgentIntegrationTargetStatus | null | undefined): string {
    if (!item?.installed) return 'Not connected';
    if (!item.current) return 'Update needed';
    return 'Connected';
  }

  function statusClass(item: AgentIntegrationTargetStatus | null | undefined): string {
    if (item?.current) return 'text-emerald-500';
    if (item?.installed) return 'text-amber-500';
    return 'text-muted-foreground';
  }

  const needsSetup = $derived(
    Boolean(status && (!status.claude.user.current || !status.codex.current))
  );
</script>

<div class="flex flex-col gap-4">
  {#if needsSetup}
    <div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100">
      Agent hooks are missing or out of date. Connect or update them so Soloe can bind Claude and
      Codex sessions for correct resume.
    </div>
  {/if}

  <div class="flex flex-col gap-2.5 rounded-md border border-border p-3">
    <div class="flex items-baseline justify-between gap-2">
      <h4 class="m-0 text-xs font-medium">Claude Code</h4>
      <span
        class="text-[10px] tracking-widest uppercase {statusClass(claudeScopeStatus)}"
      >
        {statusLabel(claudeScopeStatus)}
      </span>
    </div>
    <p class="m-0 text-[11px] text-muted-foreground">
      Installs hook entries that POST event state to Soloe so session tabs can show live agent status.
    </p>
    <div class="flex flex-col gap-1.5">
      <Label class="text-[11px] text-muted-foreground">Scope</Label>
      <RadioGroup value={scope} onValueChange={(v) => (scope = v as AgentIntegrationClaudeScope)}>
        <div class="flex items-center gap-2">
          <RadioGroupItem id="claude-scope-user" value="user" />
          <Label for="claude-scope-user" class="text-xs">
            User <span class="text-muted-foreground">(~/.claude/settings.json)</span>
          </Label>
        </div>
        <div class="flex items-center gap-2">
          <RadioGroupItem id="claude-scope-project" value="project" disabled={!projectPath} />
          <Label for="claude-scope-project" class="text-xs">
            Project
            <span class="text-muted-foreground">
              {projectPath ? `(${projectPath}/.claude/settings.json)` : '(no project open)'}
            </span>
          </Label>
        </div>
        <div class="flex items-center gap-2">
          <RadioGroupItem
            id="claude-scope-project-local"
            value="project_local"
            disabled={!projectPath}
          />
          <Label for="claude-scope-project-local" class="text-xs">
            Project local
            <span class="text-muted-foreground">
              {projectPath
                ? `(${projectPath}/.claude/settings.local.json)`
                : '(no project open)'}
            </span>
          </Label>
        </div>
      </RadioGroup>
    </div>
    <div class="flex gap-2">
      {#if claudeScopeStatus?.current}
        <Button
          size="sm"
          variant="outline"
          disabled={claudeBusy}
          onclick={uninstallClaude}
        >
          {claudeBusy ? 'Working…' : 'Disconnect'}
        </Button>
      {:else}
        <Button size="sm" disabled={claudeBusy} onclick={installClaude}>
          {claudeBusy ? 'Working…' : claudeScopeStatus?.installed ? 'Update' : 'Connect'}
        </Button>
      {/if}
    </div>
  </div>

  <div class="flex flex-col gap-2.5 rounded-md border border-border p-3">
    <div class="flex items-baseline justify-between gap-2">
      <h4 class="m-0 text-xs font-medium">Codex CLI</h4>
      <span
        class="text-[10px] tracking-widest uppercase {statusClass(status?.codex)}"
      >
        {statusLabel(status?.codex)}
      </span>
    </div>
    <p class="m-0 text-[11px] text-muted-foreground">
      Codex stores integration in <code class="text-foreground">~/.codex/config.toml</code> only — no per-project equivalent.
    </p>
    <div class="flex gap-2">
      {#if status?.codex.current}
        <Button size="sm" variant="outline" disabled={codexBusy} onclick={uninstallCodex}>
          {codexBusy ? 'Working…' : 'Disconnect'}
        </Button>
      {:else}
        <Button size="sm" disabled={codexBusy} onclick={installCodex}>
          {codexBusy ? 'Working…' : status?.codex.installed ? 'Update' : 'Connect'}
        </Button>
      {/if}
    </div>
  </div>
</div>
