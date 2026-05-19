import type { Session } from '@shared/types/sessions.js';
import { confirmStore } from '../stores/confirm.svelte';
import { settings } from '../stores/settings.svelte';
import { reportError } from '../stores/toast.svelte';

export interface ConfirmDeleteOptions {
  // Keyboard-shortcut paths set this so the dialog is unskippable: the
  // confirmDeleteTabs preference is ignored and no "Don't ask again" button
  // appears. Mouse paths (trash icon, context menu) omit it so a power user
  // can opt out via the dialog or Preferences.
  alwaysConfirm?: boolean;
}

export function shouldConfirmDeleteSession(): boolean {
  return settings.current.terminal.confirmDeleteTabs;
}

export async function confirmDeleteSession(
  session: Session,
  opts: ConfirmDeleteOptions = {}
): Promise<boolean> {
  if (!opts.alwaysConfirm && !shouldConfirmDeleteSession()) return true;

  const optOut = opts.alwaysConfirm
    ? {}
    : {
        dontAskAgainLabel: "Don't ask again",
        onDontAskAgain: () =>
          settings.update({ terminal: { confirmDeleteTabs: false } }).catch(reportError)
      };

  return confirmStore.ask({
    title: 'Delete terminal tab',
    message: `Delete terminal tab "${session.name || '(unnamed)'}"?`,
    confirmLabel: 'Delete',
    tone: 'danger',
    ...optOut
  });
}
