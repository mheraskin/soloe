import type { SessionId } from '@shared/types/sessions.js';

class SessionHandoffStore {
  isOpen = $state(false);
  originId = $state<SessionId | null>(null);

  open(originId: SessionId): void {
    this.originId = originId;
    this.isOpen = true;
  }

  close(): void {
    this.isOpen = false;
    this.originId = null;
  }
}

export const sessionHandoff = new SessionHandoffStore();
