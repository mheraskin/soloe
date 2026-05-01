import type { Session, SessionDraft } from '@shared/types/sessions.js';
import { defaultDraft, toDraft } from '../lib/sessions-helpers';
import { settings } from './settings.svelte';

export type ModalMode = 'new' | 'edit';

export interface NewSessionPrefill {
  name?: string;
  cwd?: string;
  projectId?: string;
}

class ModalStore {
  open = $state(false);
  mode = $state<ModalMode>('new');
  draft = $state<SessionDraft>(defaultDraft('standard_terminal'));
  editingId = $state<string | null>(null);
  error = $state<string | null>(null);

  openNew(prefill?: NewSessionPrefill): void {
    this.mode = 'new';
    this.editingId = null;
    const base = defaultDraft('standard_terminal', settings.current.defaults);
    this.draft = {
      ...base,
      ...(prefill?.name ? { name: prefill.name } : {}),
      ...(prefill?.cwd ? { cwd: prefill.cwd } : {}),
      ...(prefill?.projectId ? { projectId: prefill.projectId } : {})
    } as SessionDraft;
    this.error = null;
    this.open = true;
  }

  openEdit(session: Session): void {
    this.mode = 'edit';
    this.editingId = session.id;
    this.draft = toDraft(session);
    this.error = null;
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.error = null;
  }
}

export const modal = new ModalStore();
