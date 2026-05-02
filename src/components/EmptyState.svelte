<script lang="ts">
  import type { Session, SessionStatus } from '@shared/types/sessions.js';
  import { kindLabel } from '../lib/sessions-helpers';

  let { session, status }: { session: Session | null; status: SessionStatus } = $props();
</script>

<div class="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
  {#if !session}
    <h2 class="m-0 text-base font-medium text-foreground">No session selected</h2>
    <p class="m-0">Create or pick a session in the sidebar to get started.</p>
  {:else}
    <h2 class="m-0 text-base font-medium text-foreground">{session.name}</h2>
    <p class="m-0 text-xs">{kindLabel(session.kind)} · {session.runMode}{session.wslDistro ? ` (${session.wslDistro})` : ''}</p>
    <p class="m-0 font-mono text-xs">{session.cwd}</p>
    <p class="mt-3 text-xs">
      {#if status === 'starting'}
        Starting…
      {:else if status === 'error'}
        Failed to start. Right-click the session to retry.
      {:else if status === 'exited'}
        Session exited. Right-click the session to start it again.
      {:else}
        Launching session…
      {/if}
    </p>
  {/if}
</div>
