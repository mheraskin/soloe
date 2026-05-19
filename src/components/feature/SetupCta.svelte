<script lang="ts">
  import { Sparkles, ArrowRight, Loader2 } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { sessions } from '../../stores/sessions.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { sendBracketedPaste } from '../../lib/terminal-paste';

  interface Props {
    cwd: string;
    projectId?: string | null;
    branch?: string | null;
  }

  let { cwd, projectId = null, branch = null }: Props = $props();

  let busy = $state(false);

  async function launchSetup(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const created = await sessions.createAgentWithDefaults('claude_code', {
        cwd,
        ...(projectId ? { projectId } : {}),
        ...(branch ? { branch } : {})
      });
      // Race the agent's tui start: poll for the terminalId for up to 5s before
      // pasting the slash command. createAgentWithDefaults already kicks start,
      // so the pty is usually online within a couple hundred ms.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const tid = sessions.terminalIdFor(created.id);
        if (tid) {
          await sendBracketedPaste(tid, '/setup-matt-pocock-skills', true);
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch (err) {
      reportError(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-3">
  <div class="flex items-start gap-2">
    <Sparkles class="mt-0.5 size-4 shrink-0 text-amber-500" />
    <div class="flex min-w-0 flex-1 flex-col gap-2">
      <div class="flex flex-col gap-0.5">
        <span class="text-xs font-medium text-foreground">Set up agent skills</span>
        <span class="text-[11px] leading-snug text-muted-foreground">
          This worktree has no <span class="font-mono">## Agent skills</span> block in
          <span class="font-mono">CLAUDE.md</span> or <span class="font-mono">AGENTS.md</span>.
          Install Matt Pocock's grill / plan / issues skills so coverage maps and feature artifacts
          stay in sync.
        </span>
      </div>
      <Button
        variant="outline"
        size="xs"
        class="self-start gap-1.5"
        onclick={launchSetup}
        disabled={busy}
      >
        {#if busy}
          <Loader2 class="size-3 animate-spin" />
          <span>Opening session…</span>
        {:else}
          <span>Run /setup-matt-pocock-skills</span>
          <ArrowRight class="size-3" />
        {/if}
      </Button>
    </div>
  </div>
</div>
