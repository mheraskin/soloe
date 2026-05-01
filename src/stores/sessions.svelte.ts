import type {
  ObservedAgentSnapshot,
  ObserverEvent
} from '@shared/types/agents.js';
import type { ProjectId } from '@shared/types/projects.js';
import type {
  Session,
  SessionDraft,
  SessionId,
  SessionRuntimeState,
  SessionStatus,
  SessionUpdate
} from '@shared/types/sessions.js';
import { ipc } from '../lib/ipc';

const LAST_SELECTED_KEY = 'soloe.lastSelectedByProject.v1';
const UNASSIGNED_KEY = '__unassigned__';

function readLastSelectedMap(): Record<string, SessionId> {
  try {
    const raw = localStorage.getItem(LAST_SELECTED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, SessionId> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch {
    // ignore
  }
  return {};
}

function writeLastSelectedMap(map: Record<string, SessionId>): void {
  try {
    localStorage.setItem(LAST_SELECTED_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

interface RuntimeEntry extends SessionRuntimeState {
  // last known status events keep around for "exited" badge until re-start
}

class SessionsStore {
  sessions = $state<Session[]>([]);
  runtime = $state<Record<SessionId, RuntimeEntry>>({});
  observed = $state<Record<string, ObservedAgentSnapshot>>({});
  observerEvents = $state<Record<string, ObserverEvent[]>>({});
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

  byProject = $derived.by<Record<string, Session[]>>(() => {
    const out: Record<string, Session[]> = {};
    for (const session of this.sessions) {
      const key = session.projectId ?? UNASSIGNED_KEY;
      if (!out[key]) out[key] = [];
      out[key]!.push(session);
    }
    return out;
  });

  projectIds = $derived.by<string[]>(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const session of this.sessions) {
      const key = session.projectId ?? UNASSIGNED_KEY;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
    return out;
  });

  lastSelectedByProject = $state<Record<string, SessionId>>(readLastSelectedMap());

  private detachers: Array<() => void> = [];

  statusFor(id: SessionId): SessionStatus {
    return this.runtime[id]?.status ?? 'stopped';
  }

  terminalIdFor(id: SessionId): string | null {
    return this.runtime[id]?.terminalId ?? null;
  }

  observationFor(id: string): ObservedAgentSnapshot | null {
    return this.observed[id] ?? null;
  }

  childWorkersFor(id: SessionId): ObservedAgentSnapshot[] {
    return Object.values(this.observed)
      .filter((s) => s.subjectKind === 'worker' && s.originSessionId === id)
      .sort((a, b) => (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''));
  }

  eventsFor(id: string): ObserverEvent[] {
    return this.observerEvents[id] ?? [];
  }

  async load(): Promise<void> {
    this.loading = true;
    try {
      const [list, running, observed] = await Promise.all([
        ipc.sessions.list(),
        ipc.terminal.listRunning(),
        ipc.observer.list()
      ]);
      this.sessions = list;
      const next: Record<SessionId, RuntimeEntry> = {};
      for (const r of running) next[r.sessionId] = { ...r };
      this.runtime = next;
      this.observed = Object.fromEntries(observed.map((s) => [s.id, s]));
      this.pruneLastSelected();
      if (!this.selectedId && list.length > 0) {
        this.selectedId = this.pickInitialSelection(list);
      }
    } finally {
      this.loading = false;
    }
  }

  private pickInitialSelection(list: Session[]): SessionId | null {
    const lastIds = Object.values(this.lastSelectedByProject);
    for (const id of lastIds) {
      if (list.some((s) => s.id === id)) return id;
    }
    return list[0]?.id ?? null;
  }

  private pruneLastSelected(): void {
    const ids = new Set(this.sessions.map((s) => s.id));
    let changed = false;
    const next: Record<string, SessionId> = {};
    for (const [projectKey, sessionId] of Object.entries(this.lastSelectedByProject)) {
      if (ids.has(sessionId)) {
        next[projectKey] = sessionId;
      } else {
        changed = true;
      }
    }
    if (changed) {
      this.lastSelectedByProject = next;
      writeLastSelectedMap(next);
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
    this.detachers.push(
      ipc.observer.onSnapshot((snapshot) => {
        this.observed = { ...this.observed, [snapshot.id]: snapshot };
      })
    );
    this.detachers.push(
      ipc.observer.onEvent((event) => {
        const current = this.observerEvents[event.subjectId] ?? [];
        this.observerEvents = {
          ...this.observerEvents,
          [event.subjectId]: [event, ...current].slice(0, 30)
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
    const observed = { ...this.observed };
    delete observed[id];
    for (const snapshot of Object.values(observed)) {
      if (snapshot.originSessionId === id) delete observed[snapshot.id];
    }
    this.observed = observed;
    const lastMap = { ...this.lastSelectedByProject };
    let changed = false;
    for (const [projectKey, sid] of Object.entries(lastMap)) {
      if (sid === id) {
        delete lastMap[projectKey];
        changed = true;
      }
    }
    if (changed) {
      this.lastSelectedByProject = lastMap;
      writeLastSelectedMap(lastMap);
    }
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

  async stopWorker(workerId: string): Promise<void> {
    const status = await ipc.observer.stopWorkerSession(workerId);
    if (status.snapshot) {
      this.observed = { ...this.observed, [status.snapshot.id]: status.snapshot };
    }
  }

  select(id: SessionId | null): void {
    this.selectedId = id;
    if (id) {
      const session = this.sessions.find((s) => s.id === id);
      if (session) {
        const key = session.projectId ?? UNASSIGNED_KEY;
        const nextMap = { ...this.lastSelectedByProject, [key]: id };
        this.lastSelectedByProject = nextMap;
        writeLastSelectedMap(nextMap);
      }
    }
  }
}

export const PROJECT_UNASSIGNED_KEY = UNASSIGNED_KEY;

export const sessions = new SessionsStore();
