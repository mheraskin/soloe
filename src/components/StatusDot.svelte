<script lang="ts">
  import type { SessionStatus } from '@shared/types/sessions.js';

  let { status }: { status: SessionStatus } = $props();
</script>

<span class="dot {status}" title={status} aria-label={status}></span>

<style>
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted-2);
    flex-shrink: 0;
  }
  .running { background: var(--green); }
  .starting {
    background: var(--amber);
    animation: pulse 1s ease-in-out infinite;
  }
  .stopped { background: var(--muted-2); }
  .exited { background: var(--muted); opacity: 0.5; }
  .error { background: var(--red); }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
