import type {
  Session,
  SessionDraft,
  SessionId,
  SessionRuntimeState,
  SessionStatus,
  SessionUpdate
} from '@shared/types/sessions.js';
import { ipc } from '../lib/ipc';

interface RuntimeEntry extends SessionRuntimeState {
  // last known status events keep around for "exited" badge until re-start
}

class SessionsStore {
  sessions = $state<Session[]>([]);
  runtime = $state<Record<SessionId, RuntimeEntry>>({});
  selectedId = $state<SessionId | null>(null);
  loading = $state(false);

  selected = $derived(
    this.selectedId ? this.sessions.find((s) => s.id === this.selectedId) ?? null : null
  );

  groups = $derived({
    claude: this.sessions.filter((s) => s.kind === 'claude_code'),
    codex: this.sessions.filter((s) => s.kind === 'codex'),
    terminal: this.sessions.filter((s) => s.kind === 'standard_terminal')
  });

  private detachers: Array<() => void> = [];

  statusFor(id: SessionId): SessionStatus {
    return this.runtime[id]?.status ?? 'stopped';
  }

  terminalIdFor(id: SessionId): string | null {
    return this.runtime[id]?.terminalId ?? null;
  }

  async load(): Promise<void> {
    this.loading = true;
    try {
      const [list, running] = await Promise.all([
        ipc.sessions.list(),
        ipc.terminal.listRunning()
      ]);
      this.sessions = list;
      const next: Record<SessionId, RuntimeEntry> = {};
      for (const r of running) next[r.sessionId] = { ...r };
      this.runtime = next;
      if (!this.selectedId && list.length > 0) {
        this.selectedId = list[0]!.id;
      }
    } finally {
      this.loading = false;
    }
  }

  attachListeners(): void {
    this.detach();
    this.detachers.push(
      ipc.terminal.onStatus((e) => {
        const prev = this.runtime[e.sessionId];
        const merged: RuntimeEntry = {
          sessionId: e.sessionId,
          status: e.status,
          terminalId: e.terminalId,
          ...(prev?.startedAt ? { startedAt: prev.startedAt } : {}),
          ...(prev?.exitedAt ? { exitedAt: prev.exitedAt } : {}),
          ...(prev?.exitCode !== undefined ? { exitCode: prev.exitCode } : {}),
          ...(prev?.signal !== undefined ? { signal: prev.signal } : {}),
          ...(e.message ? { error: e.message } : {})
        };
        if (e.status === 'running' && !merged.startedAt) {
          merged.startedAt = new Date().toISOString();
        }
        this.runtime = { ...this.runtime, [e.sessionId]: merged };
      })
    );
    this.detachers.push(
      ipc.terminal.onExit((e) => {
        const prev = this.runtime[e.sessionId];
        this.runtime = {
          ...this.runtime,
          [e.sessionId]: {
            ...(prev ?? { sessionId: e.sessionId, status: 'exited', terminalId: null }),
            sessionId: e.sessionId,
            status: 'exited',
            terminalId: null,
            exitedAt: new Date().toISOString(),
            exitCode: e.exitCode,
            signal: e.signal
          }
        };
      })
    );
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
  }

  async create(draft: SessionDraft): Promise<Session> {
    const created = await ipc.sessions.create(draft);
    this.sessions = [created, ...this.sessions];
    this.selectedId = created.id;
    return created;
  }

  async update(id: SessionId, patch: SessionUpdate): Promise<Session> {
    const updated = await ipc.sessions.update(id, patch);
    this.sessions = this.sessions.map((s) => (s.id === id ? updated : s));
    return updated;
  }

  async remove(id: SessionId): Promise<void> {
    const rt = this.runtime[id];
    if (rt && rt.terminalId && (rt.status === 'running' || rt.status === 'starting')) {
      try {
        await ipc.terminal.stop(rt.terminalId);
      } catch {
        // continue with delete even if stop fails
      }
    }
    await ipc.sessions.delete(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    const next = { ...this.runtime };
    delete next[id];
    this.runtime = next;
    if (this.selectedId === id) {
      this.selectedId = this.sessions[0]?.id ?? null;
    }
  }

  async start(id: SessionId): Promise<void> {
    await ipc.terminal.start({ sessionId: id });
  }

  async stop(id: SessionId): Promise<void> {
    const terminalId = this.runtime[id]?.terminalId;
    if (!terminalId) return;
    await ipc.terminal.stop(terminalId);
  }

  async restart(id: SessionId): Promise<void> {
    await ipc.terminal.restart(id);
  }

  select(id: SessionId | null): void {
    this.selectedId = id;
  }
}

export const sessions = new SessionsStore();
