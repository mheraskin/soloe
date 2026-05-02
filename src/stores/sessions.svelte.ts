import type {
  ObservedAgentSnapshot,
  ObserverEvent
} from '@shared/types/agents.js';
import type {
  Session,
  SessionDraft,
  SessionId,
  SessionRuntimeState,
  SessionStatus,
  SessionUpdate
} from '@shared/types/sessions.js';
import { ipc } from '../lib/ipc';
import { projects } from './projects.svelte';
import { settings } from './settings.svelte';
import { randomName } from '../lib/random-name';

const LAST_SELECTED_KEY = 'soloe.lastSelectedByProject.v1';
const STANDALONE_KEY = '__standalone__';

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
      if (!session.projectId) continue;
      if (!out[session.projectId]) out[session.projectId] = [];
      out[session.projectId]!.push(session);
    }
    return out;
  });

  standalone = $derived.by<Session[]>(() => this.sessions.filter((s) => !s.projectId));

  projectIds = $derived.by<string[]>(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const session of this.sessions) {
      if (!session.projectId) continue;
      if (!seen.has(session.projectId)) {
        seen.add(session.projectId);
        out.push(session.projectId);
      }
    }
    return out;
  });

  lastSelectedByProject = $state<Record<string, SessionId>>(readLastSelectedMap());

  private detachers: Array<() => void> = [];
  private locationVersions = new Map<SessionId, number>();

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
        console.info('[DEBUG-terminal-start] renderer status received', e);
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
      ipc.terminal.onLocation((event) => {
        void this.applyTerminalLocation(event.sessionId, event.cwd);
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

  private async applyTerminalLocation(id: SessionId, cwd: string): Promise<void> {
    const current = this.sessions.find((s) => s.id === id);
    if (!current || current.cwd === cwd) return;
    const version = (this.locationVersions.get(id) ?? 0) + 1;
    this.locationVersions.set(id, version);
    this.sessions = this.sessions.map((s) =>
      s.id === id ? { ...s, cwd, lastBranch: undefined } : s
    );

    const status = await ipc.git.status({ cwd, force: true }).catch(() => null);
    if (this.locationVersions.get(id) !== version) return;
    const patch: SessionUpdate = { cwd, lastBranch: status?.branch ?? undefined };
    const updated = await ipc.sessions.update(id, patch).catch(() => null);
    if (!updated || this.locationVersions.get(id) !== version) return;
    this.sessions = this.sessions.map((s) => (s.id === id ? updated : s));
  }

  async create(draft: SessionDraft): Promise<Session> {
    const created = await ipc.sessions.create(draft);
    this.sessions = [created, ...this.sessions];
    this.selectedId = created.id;
    return created;
  }

  async createWithDefaults(opts: {
    projectId?: string;
    cwd?: string;
    branch?: string;
  } = {}): Promise<Session> {
    const defaults = settings.current.defaults;
    const project = opts.projectId ? projects.get(opts.projectId) : null;
    const runMode = project?.defaultRunMode ?? defaults.runMode;
    const cwd = opts.cwd ?? project?.path ?? normalizedDefaultCwd(defaults.cwd, runMode);
    const wslDistro = (() => {
      if (project?.defaultWslDistro) return project.defaultWslDistro;
      return defaults.wslDistro ?? 'Ubuntu';
    })();
    const name = this.uniqueName(randomName(), opts.projectId);
    const draft: SessionDraft = {
      kind: 'standard_terminal',
      name,
      cwd,
      runMode,
      ...(runMode === 'wsl' ? { wslDistro } : {}),
      shell: defaults.shell,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.branch ? { lastBranch: opts.branch } : {})
    };
    const created = await this.create(draft);
    try {
      await this.start(created.id);
    } catch {
      // start failure is non-fatal; the session is created
    }
    return created;
  }

  private uniqueName(base: string, projectId: string | undefined): string {
    const taken = new Set(
      this.sessions
        .filter((s) => (s.projectId ?? null) === (projectId ?? null))
        .map((s) => s.name)
    );
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
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

  async archive(id: SessionId): Promise<void> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session?.projectId) {
      await this.remove(id);
      return;
    }
    const rt = this.runtime[id];
    if (rt && rt.terminalId && (rt.status === 'running' || rt.status === 'starting')) {
      try {
        await ipc.terminal.stop(rt.terminalId);
      } catch {
        // continue with archive even if stop fails
      }
    }
    await ipc.sessions.update(id, { archivedAt: new Date().toISOString() });
    this.sessions = this.sessions.filter((s) => s.id !== id);
    const next = { ...this.runtime };
    delete next[id];
    this.runtime = next;
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
    this.select(id);
    console.info('[DEBUG-terminal-start] renderer start requested', { sessionId: id });
    this.runtime = {
      ...this.runtime,
      [id]: {
        ...(this.runtime[id] ?? { sessionId: id, terminalId: null }),
        sessionId: id,
        status: 'starting',
        terminalId: null
      }
    };
    const result = await ipc.terminal.start({ sessionId: id });
    console.info('[DEBUG-terminal-start] renderer start returned', {
      sessionId: id,
      terminalId: result.terminalId,
      pid: result.pid
    });
    this.runtime = {
      ...this.runtime,
      [id]: {
        ...(this.runtime[id] ?? { sessionId: id, terminalId: result.terminalId }),
        sessionId: id,
        status: 'running',
        terminalId: result.terminalId,
        startedAt: new Date().toISOString()
      }
    };
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
        const key = session.projectId ?? STANDALONE_KEY;
        const nextMap = { ...this.lastSelectedByProject, [key]: id };
        this.lastSelectedByProject = nextMap;
        writeLastSelectedMap(nextMap);
      }
    }
  }
}

export const sessions = new SessionsStore();

function normalizedDefaultCwd(cwd: string, runMode: 'windows' | 'wsl'): string {
  if (runMode !== 'wsl') return cwd;
  if (/^\/mnt\/[a-z]\/Users\/[^/\\]+\/?$/i.test(cwd)) return '~';
  if (/^[a-z]:[\\/]+Users[\\/]+[^\\/]+[\\/]?$/i.test(cwd)) return '~';
  return cwd;
}
