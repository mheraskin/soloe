import type { Component } from 'svelte';
import {
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Hourglass,
  Loader2,
  LogOut,
  MessageSquareText,
  Wrench,
  XCircle
} from '@lucide/svelte';
import type { AgentObservedState } from '@shared/types/sessions.js';

// How loud a state is allowed to be. `chip` is reserved for states that want a
// human to come back — everything else stays plain coloured text so the
// sidebar has exactly one thing shouting at a time.
export type AgentStateTone = 'idle' | 'active' | 'done' | 'attention' | 'danger';

export interface AgentStatePresentation {
  label: string;
  tone: AgentStateTone;
  icon: Component | null;
  spin: boolean;
  chip: boolean;
}

const PRESENTATION: Record<AgentObservedState, AgentStatePresentation> = {
  starting: { label: 'Starting', tone: 'active', icon: Loader2, spin: true, chip: false },
  idle: { label: 'Idle', tone: 'idle', icon: null, spin: false, chip: false },
  working: { label: 'Thinking', tone: 'active', icon: Loader2, spin: true, chip: false },
  running_tool: { label: 'Tool', tone: 'active', icon: Wrench, spin: false, chip: false },
  waiting_for_input: {
    label: 'Input',
    tone: 'attention',
    icon: MessageSquareText,
    spin: false,
    chip: true
  },
  waiting_for_approval: {
    label: 'Approve',
    tone: 'danger',
    icon: AlertTriangle,
    spin: false,
    chip: true
  },
  usage_limited: { label: 'Limit', tone: 'attention', icon: Gauge, spin: false, chip: true },
  completed: { label: 'Done', tone: 'done', icon: CheckCircle2, spin: false, chip: false },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle, spin: false, chip: true },
  exited: { label: 'Exited', tone: 'idle', icon: LogOut, spin: false, chip: false }
};

const FALLBACK: AgentStatePresentation = {
  label: 'Unknown',
  tone: 'idle',
  icon: Hourglass,
  spin: false,
  chip: false
};

export function agentStatePresentation(state: AgentObservedState): AgentStatePresentation {
  return PRESENTATION[state] ?? { ...FALLBACK, label: state };
}
