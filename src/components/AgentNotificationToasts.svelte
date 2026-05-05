<script lang="ts">
  import type { Component } from 'svelte';
  import type { NotifyState } from '../stores/agent-notifications.svelte';
  import { agentNotifications } from '../stores/agent-notifications.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { CheckCircle2, Gauge, MessageSquareText, ShieldAlert, XCircle } from '@lucide/svelte';
  import { cn } from '$lib/utils';
  import KindIcon from './KindIcon.svelte';

  const stateIcons = {
    waiting_for_input: {
      icon: MessageSquareText,
      class: 'text-warning'
    },
    waiting_for_approval: {
      icon: ShieldAlert,
      class: 'text-destructive'
    },
    usage_limited: {
      icon: Gauge,
      class: 'text-warning'
    },
    completed: {
      icon: CheckCircle2,
      class: 'text-success'
    },
    failed: {
      icon: XCircle,
      class: 'text-destructive'
    }
  } satisfies Record<NotifyState, { icon: Component; class: string }>;

  function activate(sessionId: string): void {
    sessions.select(sessionId);
    agentNotifications.dismissToast(sessionId);
  }
</script>

{#if agentNotifications.toasts.length > 0}
  <div
    class="pointer-events-none fixed top-9 left-1/2 z-50 flex w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2"
    aria-live="polite"
    aria-atomic="false"
  >
    {#each agentNotifications.toasts as toast (toast.sessionId)}
      {@const stateIcon = stateIcons[toast.state]}
      {@const StateIcon = stateIcon.icon}
      <button
        type="button"
        class="pointer-events-auto grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2 rounded-md border border-border bg-popover/95 px-3 py-2 text-left text-popover-foreground shadow-lg backdrop-blur transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onclick={() => activate(toast.sessionId)}
        aria-label={`${toast.sessionName}: ${toast.reason}`}
      >
        <KindIcon kind={toast.sessionKind} size={14} />
        <StateIcon class={cn('size-3.5', stateIcon.class)} />
        <span class="grid min-w-0 gap-0.5">
          <span class="truncate text-xs leading-4 font-medium">{toast.sessionName}</span>
          <span class="truncate text-[11px] leading-3.5 text-muted-foreground">
            {toast.reason}
          </span>
        </span>
      </button>
    {/each}
  </div>
{/if}
