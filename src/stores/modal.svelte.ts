import type { Session, SessionDraft, SessionKind } from '@shared/types/sessions.js';
import { defaultDraft, toDraft } from '../lib/sessions-helpers';

export type ModalMode = 'new' | 'edit';

class ModalStore {
  open = $state(false);
  mode = $state<ModalMode>('new');
  draft = $state<SessionDraft>(defaultDraft('standard_terminal'));
  editingId = $state<string | null>(null);
  error = $state<string | null>(null);

  openNew(kind: SessionKind = 'standard_terminal'): void {
    this.mode = 'new';
    this.editingId = null;
    this.draft = defaultDraft(kind);
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

  setKind(kind: SessionKind): void {
    if (this.mode === 'edit') return;
    const preserved = {
      name: this.draft.name,
      cwd: this.draft.cwd,
      runMode: this.draft.runMode,
      wslDistro: this.draft.wslDistro
    };
    const fresh = defaultDraft(kind);
    this.draft = {
      ...fresh,
      name: preserved.name,
      cwd: preserved.cwd,
      runMode: preserved.runMode,
      ...(preserved.wslDistro ? { wslDistro: preserved.wslDistro } : {})
    } as SessionDraft;
  }

  close(): void {
    this.open = false;
    this.error = null;
  }
}

export const modal = new ModalStore();
