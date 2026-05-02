<script lang="ts">
  import type { AgentObservedState } from '@shared/types/sessions.js';
  import {
    Wrench,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    Hourglass,
    Loader2,
    MessageSquareText,
    LogOut
  } from '@lucide/svelte';
  import { cn } from '$lib/utils';
  import type { Component } from 'svelte';

  let {
    state,
    summary = null,
    class: className = ''
  }: {
    state: AgentObservedState;
    summary?: string | null;
    class?: string;
  } = $props();

  type BadgeStyle = {
    label: string;
    icon: Component | null;
    iconClass: string;
    pillClass: string;
  };

  const styles: Record<AgentObservedState, BadgeStyle> = {
    starting: {
      label: 'starting',
      icon: Loader2,
      iconClass: 'animate-spin',
      pillClass: 'border-warning/40 bg-warning/10 text-warning'
    },
    idle: {
      label: 'idle',
      icon: null,
      iconClass: '',
      pillClass: 'border-border bg-muted/40 text-muted-foreground'
    },
    working: {
      label: 'thinking',
      icon: Loader2,
      iconClass: 'animate-spin',
      pillClass: 'border-primary/40 bg-primary/10 text-primary'
    },
    running_tool: {
      label: 'tool',
      icon: Wrench,
      iconClass: '',
      pillClass: 'border-primary/40 bg-primary/10 text-primary'
    },
    waiting_for_input: {
      label: 'input',
      icon: MessageSquareText,
      iconClass: '',
      pillClass: 'border-warning/40 bg-warning/10 text-warning'
    },
    waiting_for_approval: {
      label: 'approval',
      icon: AlertTriangle,
      iconClass: '',
      pillClass: 'border-destructive/40 bg-destructive/10 text-destructive'
    },
    completed: {
      label: 'done',
      icon: CheckCircle2,
      iconClass: '',
      pillClass: 'border-success/40 bg-success/10 text-success'
    },
    failed: {
      label: 'failed',
      icon: XCircle,
      iconClass: '',
      pillClass: 'border-destructive/40 bg-destructive/10 text-destructive'
    },
    exited: {
      label: 'exited',
      icon: LogOut,
      iconClass: '',
      pillClass: 'border-border bg-muted/40 text-muted-foreground'
    }
  };

  const style = $derived(styles[state] ?? {
    label: state,
    icon: Hourglass,
    iconClass: '',
    pillClass: 'border-border bg-muted/40 text-muted-foreground'
  });

  const tooltip = $derived(summary ? `${style.label} · ${summary}` : style.label);
  const Icon = $derived(style.icon);
  const detail = $derived(state === 'running_tool' && summary ? summary.replace(/^tool:\s*/i, '') : null);
</script>

<span
  class={cn(
    'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide leading-none',
    style.pillClass,
    className
  )}
  title={tooltip}
  aria-label={tooltip}
>
  {#if Icon}
    <Icon class={cn('size-2.5', style.iconClass)} />
  {/if}
  <span>{detail ?? style.label}</span>
</span>
