<script lang="ts">
  import type { Component } from 'svelte';
  import type { NotifyState } from '../stores/agent-notifications.svelte';
  import { agentNotifications } from '../stores/agent-notifications.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { agentNotificationBreadcrumb } from '../lib/agent-notification-context';
  import { CheckCircle2, Gauge, MessageSquareText, ShieldAlert, X, XCircle } from '@lucide/svelte';
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

  // Click handler for the row's close affordance. Stops propagation so the
  // surrounding "activate session" button doesn't also fire — dismissing the
  // toast is a distinct action from acknowledging it.
  function dismiss(event: Event, sessionId: string): void {
    event.stopPropagation();
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
      {@const session = sessions.sessions.find((candidate) => candidate.id === toast.sessionId)}
      {@const breadcrumbSession = session ?? {
        name: toast.sessionName,
        cwd: toast.cwd,
        runMode: toast.runMode,
        lastBranch: toast.lastBranch
      }}
      {@const breadcrumb = agentNotificationBreadcrumb(
        breadcrumbSession,
        projects.get(session?.projectId ?? toast.projectId)
      )}
      <div
        class="pointer-events-auto relative rounded-md border border-border bg-popover/95 text-popover-foreground shadow-lg backdrop-blur transition-colors hover:bg-accent focus-within:ring-2 focus-within:ring-ring"
      >
        <button
          type="button"
          class="grid w-full grid-cols-[16px_minmax(0,1fr)] items-center gap-2 px-3 py-2 pr-8 text-left focus-visible:outline-none"
          onclick={() => activate(toast.sessionId)}
          aria-label={`${breadcrumb.join(' › ')}: ${toast.reason}`}
        >
          <span class="flex flex-col items-center justify-center gap-0.5" aria-hidden="true">
            <KindIcon kind={toast.sessionKind} size={12} />
            <StateIcon class={cn('size-3', stateIcon.class)} />
          </span>
          <span class="grid min-w-0 gap-0.5">
            <span class="flex min-w-0 items-center gap-1 overflow-hidden text-xs leading-4">
              {#each breadcrumb as crumb, index (index)}
                {#if index > 0}
                  <span class="shrink-0 text-muted-foreground/50" aria-hidden="true">›</span>
                {/if}
                <span
                  class={index === breadcrumb.length - 1
                    ? 'min-w-0 truncate font-medium text-foreground'
                    : 'min-w-0 truncate text-muted-foreground'}
                  title={crumb}
                >{crumb}</span>
              {/each}
            </span>
            <span class="truncate text-[11px] leading-3.5 text-muted-foreground">
              {toast.reason}
            </span>
          </span>
        </button>
        <button
          type="button"
          class="absolute top-1.5 right-1.5 inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onclick={(e) => dismiss(e, toast.sessionId)}
          aria-label={`Dismiss notification for ${toast.sessionName}`}
          title="Dismiss"
        >
          <X class="size-3" />
        </button>
      </div>
    {/each}
  </div>
{/if}
