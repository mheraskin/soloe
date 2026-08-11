<script lang="ts">
  import type { SessionStatus } from '@shared/types/sessions.js';
  import { cn } from '$lib/utils';

  let { status, class: className = '' }: { status: SessionStatus; class?: string } = $props();

  const colorByStatus: Record<SessionStatus, string> = {
    running: 'bg-success',
    starting: 'bg-warning animate-pulse',
    stopped: 'bg-muted-foreground/60',
    exited: 'bg-muted-foreground/30',
    error: 'bg-destructive'
  };
</script>

<span
  class={cn('inline-block size-2 shrink-0 rounded-full', colorByStatus[status], className)}
  title={status}
  aria-label={status}
></span>
