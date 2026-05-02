import type { Session, SessionDraft } from '@shared/types/sessions.js';
import { defaultDraft, toDraft } from '../lib/sessions-helpers';

class ModalStore {
  open = $state(false);
  draft = $state<SessionDraft>(defaultDraft('standard_terminal'));
  editingId = $state<string | null>(null);
  error = $state<string | null>(null);

  openEdit(session: Session): void {
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
