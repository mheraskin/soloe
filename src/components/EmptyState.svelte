<script lang="ts">
  import {
    Loader2,
    Play,
    Plus,
    AlertTriangle,
    Terminal,
    FolderOpen,
    Command,
    Copy
  } from '@lucide/svelte';
  import type { AgentRuntimeProvider, Session, SessionStatus } from '@shared/types/sessions.js';
  import type { QuickLaunchPreset } from '@shared/types/settings.js';
  import { launchKind, launchProvider } from '@shared/types/sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { commandPalette } from '../stores/command-palette.svelte';
  import { settings } from '../stores/settings.svelte';
  import { reportError, toasts } from '../stores/toast.svelte';
  import { kindLabel } from '../lib/sessions-helpers';
  import { Keymap } from '../lib/keymap';
  import { Button } from '$lib/components/ui/button';
  import { displaySessionKind } from '../lib/session-agent';
  import {
    exitedSessionQuickLaunchPresets,
    quickLaunchExtraArgs
  } from '../lib/quick-launch';
  import KindIcon from './KindIcon.svelte';
  import KbdHint from './KbdHint.svelte';

  let { session, status }: { session: Session | null; status: SessionStatus } = $props();

  let busy = $state(false);
  let busyProvider = $state<AgentRuntimeProvider | null>(null);
  let busyPresetId = $state<string | null>(null);
  let observed = $derived(session ? sessions.observationFor(session.id) : null);
  let displayKind = $derived(session ? displaySessionKind(session, observed) : 'terminal');
  let canContinueAcrossAgents = $derived(
    session !== null && (displayKind === 'claude_code' || displayKind === 'codex')
  );
  let quickLaunchPresets = $derived(
    exitedSessionQuickLaunchPresets(settings.current.quickLaunch)
  );
  let providerSessionId = $derived.by(() => {
    if (!session) return null;
    if (displayKind === 'claude_code') {
      return (
        (session.currentAgentRuntime?.provider === 'claude_code'
          ? session.currentAgentRuntime.providerThreadId
          : undefined)
        ?? session.providerThreadId
        ?? observed?.providerThreadId
        ?? (session.launch.type === 'agent' && session.launch.provider === 'claude_code'
          ? session.launch.claudeSessionId
          : undefined)
        ?? null
      );
    }
    if (displayKind === 'codex') {
      return (
        (session.currentAgentRuntime?.provider === 'codex'
          ? session.currentAgentRuntime.providerThreadId
          : undefined)
        ?? session.providerThreadId
        ?? observed?.providerThreadId
        ?? (session.launch.type === 'agent' && session.launch.provider === 'codex'
          ? session.launch.codexSessionId
          : undefined)
        ?? null
      );
    }
    return null;
  });
  let providerResumeCommand = $derived.by(() => {
    if (!providerSessionId) return null;
    if (displayKind === 'claude_code') return `claude --resume ${providerSessionId}`;
    if (displayKind === 'codex') return `codex resume ${providerSessionId}`;
    return null;
  });

  async function resume() {
    if (!session || busy) return;
    busy = true;
    try {
      await sessions.start(session.id);
    } catch (err) {
      reportError(err);
    } finally {
      busy = false;
    }
  }

  async function openNew() {
    if (!session || busy) return;
    busy = true;
    try {
      const opts = {
        ...(session.projectId ? { projectId: session.projectId } : {}),
        cwd: session.cwd,
        ...(session.lastBranch ? { branch: session.lastBranch } : {})
      };
      const provider = launchProvider(session);
      const created = provider
        ? await sessions.createAgentWithDefaults(provider, opts)
        : await sessions.createWithDefaults(opts);
      sessions.select(created.id);
    } catch (err) {
      reportError(err);
    } finally {
      busy = false;
    }
  }

  async function continueWith(provider: AgentRuntimeProvider) {
    if (!session || busyProvider) return;
    busyProvider = provider;
    try {
      const created = await sessions.continueWithAgent(session.id, provider);
      sessions.select(created.id);
    } catch (err) {
      reportError(err);
    } finally {
      busyProvider = null;
    }
  }

  async function launchPreset(preset: QuickLaunchPreset): Promise<void> {
    if (!session || busyPresetId) return;
    busyPresetId = preset.id;
    try {
      const args = quickLaunchExtraArgs(preset);
      const created = await sessions.createAgentWithDefaults(preset.provider, {
        ...(session.projectId ? { projectId: session.projectId } : {}),
        cwd: session.cwd,
        ...(session.lastBranch ? { branch: session.lastBranch } : {}),
        runMode: session.runMode,
        ...(session.wslDistro ? { wslDistro: session.wslDistro } : {}),
        ...(preset.model ? { model: preset.model } : {}),
        ...(args.length > 0 ? { extraArgs: args } : {})
      });
      sessions.select(created.id);
    } catch (err) {
      reportError(err);
    } finally {
      busyPresetId = null;
    }
  }

  async function quickNewSession() {
    if (busy) return;
    busy = true;
    try {
      const created = await sessions.createPreferredWithDefaults({});
      sessions.select(created.id);
    } catch (err) {
      reportError(err);
    } finally {
      busy = false;
    }
  }

  function quickOpenProject() {
    commandPalette.open('open-project');
  }

  function quickCommandPalette() {
    commandPalette.toggle();
  }

  async function copyProviderResumeCommand() {
    if (!providerResumeCommand) return;
    try {
      await navigator.clipboard.writeText(providerResumeCommand);
      toasts.push('Copied resume command', 'info');
    } catch (err) {
      reportError(err);
    }
  }
</script>

<div class="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
  {#if !session}
    <div class="flex w-full max-w-xs flex-col items-center gap-6">
      <span class="relative flex size-16 items-center justify-center">
        <span class="absolute inset-0 rounded-2xl bg-foreground/[0.04]"></span>
        <span class="absolute inset-0 rounded-2xl ring-1 ring-border/60"></span>
        <Terminal class="relative size-7 text-muted-foreground/80" />
      </span>
      <div class="flex flex-col items-center gap-1.5">
        <h2 class="m-0 text-base font-semibold text-foreground">Nothing selected</h2>
        <p class="m-0 max-w-[24ch] text-xs leading-relaxed text-muted-foreground">
          Pick a session from the sidebar, or jump in below.
        </p>
      </div>
      <div class="flex w-full flex-col gap-1.5">
        <Button
          variant="outline"
          size="sm"
          class="w-full justify-between"
          onclick={quickNewSession}
          disabled={busy}
        >
          <span class="flex items-center gap-2">
            <Plus class="size-3.5" />
            <span>New session</span>
          </span>
          <KbdHint keys={Keymap.newSession.keys} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          class="w-full justify-between"
          onclick={quickOpenProject}
        >
          <span class="flex items-center gap-2">
            <FolderOpen class="size-3.5" />
            <span>Open project</span>
          </span>
          <KbdHint keys={Keymap.openProject.keys} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class="w-full justify-between text-muted-foreground"
          onclick={quickCommandPalette}
        >
          <span class="flex items-center gap-2">
            <Command class="size-3.5" />
            <span>Command palette</span>
          </span>
          <KbdHint keys={Keymap.commandPalette.keys} />
        </Button>
      </div>
    </div>
  {:else}
    <h2 class="m-0 text-base font-medium text-foreground">{session.name}</h2>
    <p class="m-0 text-xs">{kindLabel(launchKind(session))} · {session.runMode}{session.wslDistro ? ` (${session.wslDistro})` : ''}</p>
    <p class="m-0 font-mono text-xs">{session.cwd}</p>
    {#if status === 'starting'}
      <div class="mt-3 flex items-center gap-2 text-xs">
        <Loader2 class="size-4 animate-spin" />
        <span>Starting session…</span>
      </div>
    {:else if status === 'stopped' || status === 'exited' || status === 'error'}
      <div class="mt-3 flex items-center gap-2 text-xs {status === 'error' ? 'text-destructive' : ''}">
        {#if status === 'error'}
          <AlertTriangle class="size-3.5" />
          <span>Session failed to start.</span>
        {:else if status === 'stopped'}
          <span>Session is stopped.</span>
        {:else}
          <span>Session exited.</span>
        {/if}
      </div>
      <div class="mt-2 flex items-center gap-2">
        <Button size="sm" onclick={resume} disabled={busy}>
          <Play /> <span>Resume</span>
        </Button>
        <Button size="sm" variant="outline" onclick={openNew} disabled={busy}>
          <Plus /> <span>New session</span>
        </Button>
      </div>
      {#if providerSessionId && providerResumeCommand}
        <div class="mt-3 flex w-full max-w-xl flex-col gap-1.5 rounded-md border border-border/70 bg-muted/20 p-3 text-left">
          <div class="flex items-center justify-between gap-3">
            <span class="text-[11px] font-medium text-muted-foreground">Provider session ID</span>
            <code class="min-w-0 font-mono text-[11px] break-all text-foreground">{providerSessionId}</code>
          </div>
          <div class="flex items-center gap-2">
            <code class="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px] break-all text-foreground">
              {providerResumeCommand}
            </code>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Copy resume command"
              onclick={copyProviderResumeCommand}
            >
              <Copy />
            </Button>
          </div>
        </div>
      {/if}
      {#if canContinueAcrossAgents}
        <div class="mt-2 flex flex-col items-center gap-1.5">
          <span class="text-[11px] leading-4 text-muted-foreground">Continue in another agent</span>
          <div class="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              class="gap-2"
              onclick={() => void continueWith('claude_code')}
              disabled={busyProvider !== null}
            >
              {#if busyProvider === 'claude_code'}
                <Loader2 class="size-3.5 animate-spin" />
              {:else}
                <KindIcon kind="claude_code" size={14} />
              {/if}
              <span>Claude</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              class="gap-2"
              onclick={() => void continueWith('codex')}
              disabled={busyProvider !== null}
            >
              {#if busyProvider === 'codex'}
                <Loader2 class="size-3.5 animate-spin" />
              {:else}
                <KindIcon kind="codex" size={14} />
              {/if}
              <span>Codex</span>
            </Button>
          </div>
        </div>
      {/if}
      {#if quickLaunchPresets.length > 0}
        <div class="mt-2 flex flex-col items-center gap-1.5">
          <span class="text-[11px] leading-4 text-muted-foreground">Quick launch</span>
          <div class="flex flex-wrap items-center justify-center gap-2">
            {#each quickLaunchPresets as preset (preset.id)}
              <Button
                size="sm"
                variant="outline"
                class="gap-2"
                onclick={() => void launchPreset(preset)}
                disabled={busyPresetId !== null}
              >
                {#if busyPresetId === preset.id}
                  <Loader2 class="size-3.5 animate-spin" />
                {:else}
                  <KindIcon kind={preset.provider} size={14} />
                {/if}
                <span>{preset.label}</span>
              </Button>
            {/each}
          </div>
        </div>
      {/if}
    {:else}
      <div class="mt-3 flex items-center gap-2 text-xs">
        <Loader2 class="size-4 animate-spin" />
        <span>Launching session…</span>
      </div>
    {/if}
  {/if}
</div>
