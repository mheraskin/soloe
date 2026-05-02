<script lang="ts">
  import { Loader2, Play, Plus, AlertTriangle } from '@lucide/svelte';
  import type { Session, SessionStatus, SessionKind } from '@shared/types/sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { kindLabel } from '../lib/sessions-helpers';
  import { Button } from '$lib/components/ui/button';

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
</script>

<div class="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
  {#if !session}
    <h2 class="m-0 text-base font-medium text-foreground">No session selected</h2>
    <p class="m-0">Create or pick a session in the sidebar to get started.</p>
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
