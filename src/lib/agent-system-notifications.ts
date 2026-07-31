import type { AgentToastNotice, NotifyState } from '../stores/agent-notifications.svelte';
import { worktreeBasename } from './worktree-path';

export const AGENT_NOTIFICATION_ACTIVATE_EVENT = 'soloe:notification-activate';

export interface AgentSystemNotificationContent {
  title: string;
  body: string;
  tag: string;
}

const stateLabels = {
  waiting_for_input: 'Input needed',
  waiting_for_approval: 'Approval needed',
  usage_limited: 'Usage limit reached',
  completed: 'Completed',
  failed: 'Failed'
} satisfies Record<NotifyState, string>;

export function agentNotificationStateLabel(state: NotifyState): string {
  return stateLabels[state];
}

export function agentProviderLabel(kind: AgentToastNotice['sessionKind']): string {
  if (kind === 'codex') return 'Codex';
  if (kind === 'claude_code') return 'Claude Code';
  return 'Terminal';
}

export function agentSystemNotificationContent(
  toast: AgentToastNotice
): AgentSystemNotificationContent {
  const context = [
    agentProviderLabel(toast.sessionKind),
    worktreeBasename(toast.cwd),
    toast.sessionName
  ].filter(Boolean).join(' · ');
  return {
    title: agentNotificationStateLabel(toast.state),
    body: toast.reason === agentNotificationStateLabel(toast.state).toLowerCase()
      ? context
      : `${context}\n${toast.reason}`,
    tag: `soloe-agent-${toast.sessionId}`
  };
}

export function agentNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestAgentNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

export async function showAgentSystemNotification(toast: AgentToastNotice): Promise<boolean> {
  if (agentNotificationPermission() !== 'granted') return false;
  const content = agentSystemNotificationContent(toast);
  const options: NotificationOptions = {
    body: content.body,
    tag: content.tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { sessionId: toast.sessionId }
  };

  if (!navigator.userAgent.includes('Electron') && 'serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    if (registration) {
      await registration.showNotification(content.title, options);
      return true;
    }
  }

  const notification = new Notification(content.title, options);
  notification.onclick = () => {
    window.focus();
    window.dispatchEvent(new CustomEvent(AGENT_NOTIFICATION_ACTIVATE_EVENT, {
      detail: { sessionId: toast.sessionId }
    }));
    notification.close();
  };
  return true;
}
