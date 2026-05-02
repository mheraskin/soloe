import type { Session } from '@shared/types/sessions.js';
import { confirmStore } from '../stores/confirm.svelte';
import { settings } from '../stores/settings.svelte';
import { reportError } from '../stores/toast.svelte';

export function shouldConfirmDeleteSession(): boolean {
  return settings.current.terminal.confirmDeleteTabs;
}

export async function confirmDeleteSession(session: Session): Promise<boolean> {
  if (!shouldConfirmDeleteSession()) return true;

  return confirmStore.ask({
    title: 'Delete terminal tab',
    message: `Delete terminal tab "${session.name || '(unnamed)'}"?`,
    confirmLabel: 'Delete',
    dontAskAgainLabel: "Don't ask again",
    onDontAskAgain: () =>
      settings.update({ terminal: { confirmDeleteTabs: false } }).catch(reportError),
    tone: 'danger'
  });
}
