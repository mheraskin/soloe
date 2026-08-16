import type { Session, SessionDraft } from '@shared/types/sessions.js';
import { defaultDraft, toDraft } from '../lib/sessions-helpers';

class ModalStore {
  open = $state(false);
  draft = $state<SessionDraft>(defaultDraft('terminal'));
  editingId = $state<string | null>(null);
  error = $state<string | null>(null);
  update = $state<((draft: SessionDraft) => Promise<void>) | null>(null);

  openEdit(
    session: Session,
    update: ((draft: SessionDraft) => Promise<void>) | null = null
  ): void {
    this.editingId = session.id;
    this.draft = toDraft(session);
    this.update = update;
    this.error = null;
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.error = null;
    this.editingId = null;
    this.update = null;
  }
}

export const modal = new ModalStore();
