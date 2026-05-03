<script lang="ts">
  import {
    Loader2,
    Play,
    Plus,
    AlertTriangle,
    Terminal,
    FolderOpen,
    Command
  } from '@lucide/svelte';
  import type { Session, SessionStatus, SessionKind } from '@shared/types/sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { commandPalette } from '../stores/command-palette.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { kindLabel } from '../lib/sessions-helpers';
  import { Keymap } from '../lib/keymap';
  import { Button } from '$lib/components/ui/button';
  import KbdHint from './KbdHint.svelte';

  let { session, status }: { session: Session | null; status: SessionStatus } = $props();

  let busy = $state(false);

  function isAgentKind(kind: SessionKind): kind is Extract<SessionKind, 'claude_code' | 'codex'> {
    return kind === 'claude_code' || kind === 'codex';
  }

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
      const created = isAgentKind(session.kind)
        ? await sessions.createAgentWithDefaults(session.kind, opts)
        : await sessions.createWithDefaults(opts);
      sessions.select(created.id);
    } catch (err) {
      reportError(err);
    } finally {
      busy = false;
    }
  }

  async function quickNewSession() {
    if (busy) return;
    busy = true;
    try {
      const created = await sessions.createWithDefaults({});
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
    <p class="m-0 text-xs">{kindLabel(session.kind)} · {session.runMode}{session.wslDistro ? ` (${session.wslDistro})` : ''}</p>
    <p class="m-0 font-mono text-xs">{session.cwd}</p>
    {#if status === 'starting'}
      <div class="mt-3 flex items-center gap-2 text-xs">
        <Loader2 class="size-4 animate-spin" />
        <span>Starting session…</span>
      </div>
    {:else if status === 'exited' || status === 'error'}
      <div class="mt-3 flex items-center gap-2 text-xs {status === 'error' ? 'text-destructive' : ''}">
        {#if status === 'error'}
          <AlertTriangle class="size-3.5" />
          <span>Session failed to start.</span>
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
    {:else}
      <div class="mt-3 flex items-center gap-2 text-xs">
        <Loader2 class="size-4 animate-spin" />
        <span>Launching session…</span>
      </div>
    {/if}
  {/if}
</div>
