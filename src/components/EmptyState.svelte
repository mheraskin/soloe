<script lang="ts">
  import type { Session, SessionStatus } from '@shared/types/sessions.js';
  import { kindLabel } from '../lib/sessions-helpers';

  let { session, status }: { session: Session | null; status: SessionStatus } = $props();
</script>

<div class="empty">
  {#if !session}
    <h2>No session selected</h2>
    <p>Create or pick a session in the sidebar to get started.</p>
  {:else}
    <h2>{session.name}</h2>
    <p class="meta">{kindLabel(session.kind)} · {session.runMode}{session.wslDistro ? ` (${session.wslDistro})` : ''}</p>
    <p class="cwd">{session.cwd}</p>
    <p class="hint">
      {#if status === 'exited'}
        Session exited. Use the Start button above to run it again.
      {:else if status === 'error'}
        Failed to start. Check your settings and try again.
      {:else}
        Press <strong>Start</strong> in the toolbar above to launch this session.
      {/if}
    </p>
  {/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--muted);
    gap: 8px;
    padding: 32px;
    text-align: center;
  }
  h2 {
    margin: 0;
    color: var(--fg);
    font-weight: 500;
    font-size: 16px;
  }
  p { margin: 0; }
  .meta { font-size: 12px; }
  .cwd {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted-2);
  }
  .hint {
    margin-top: 16px;
    font-size: 12px;
  }
</style>
