import type {
  ObservedAgentSnapshot,
  ObserverEvent
} from '@shared/types/agents.js';
import type {
  Session,
  SessionDraft,
  SessionId,
  SessionRuntimeState,
  SessionLaunchKind,
  AgentRuntimeProvider,
  RunMode,
  SessionStatus,
  SessionUpdate
} from '@shared/types/sessions.js';
import { launchProvider } from '@shared/types/sessions.js';
import { ipc } from '../lib/ipc';
import { projects } from './projects.svelte';
import { settings } from './settings.svelte';
import { randomName } from '../lib/random-name';
import { agentNotifications, rowSessionIdFor } from './agent-notifications.svelte';
import { rightRail } from './right-rail.svelte';
import { sendBracketedPaste } from '../lib/terminal-paste';

const LAST_SELECTED_BY_PROJECT_KEY = 'soloe.lastSelectedByProject.v1';
const LAST_SELECTED_BY_WORKTREE_KEY = 'soloe.lastSelectedByWorktree.v1';
const STANDALONE_KEY = '__standalone__';

const SPLIT_RATIO_KEY = 'soloe.terminalSplitRatio.v1';
const SPLIT_RATIO_MIN = 0.2;
const SPLIT_RATIO_MAX = 0.8;

function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, value));
}

function readSplitRatio(): number {
  try {
    const raw = localStorage.getItem(SPLIT_RATIO_KEY);
    return raw ? clampSplitRatio(Number(raw)) : 0.5;
  } catch {
    return 0.5;
  }
}

function writeSplitRatio(value: number): void {
  try {
    localStorage.setItem(SPLIT_RATIO_KEY, String(value));
  } catch {
    // ignore
  }
}

function normPath(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

function readLastSelectedMap(storageKey: string): Record<string, SessionId> {
  try {
    const raw = localStorage.getItem(storageKey);
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

function writeLastSelectedMap(storageKey: string, map: Record<string, SessionId>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function worktreeSelectionKey(args: {
  projectId?: string | null;
  cwd: string;
  runMode: RunMode;
  wslDistro?: string | null;
}): string {
  return [
    args.projectId ?? STANDALONE_KEY,
    normPath(args.cwd),
    args.runMode,
    args.wslDistro ?? ''
  ].join('\u001f');
}

function dropSelectedId(
  map: Record<string, SessionId>,
  id: SessionId
): { next: Record<string, SessionId>; changed: boolean } {
  const next = { ...map };
  let changed = false;
  for (const [key, sessionId] of Object.entries(next)) {
    if (sessionId === id) {
      delete next[key];
      changed = true;
    }
  }
  return { next, changed };
}

interface RuntimeEntry extends SessionRuntimeState {
  // last known status events keep around for "exited" badge until re-start
}

class SessionsStore {
  sessions = $state<Session[]>([]);
  archived = $state<Session[]>([]);
  runtime = $state<Record<SessionId, RuntimeEntry>>({});
  observed = $state<Record<string, ObservedAgentSnapshot>>({});
  observerEvents = $state<Record<string, ObserverEvent[]>>({});
  selectedId = $state<SessionId | null>(null);
  loading = $state(false);
  showArchivedFor = $state<Record<string, boolean>>({});

  // Terminal split: the focused pane is always `selected`; `splitCompanionId`
  // is the other half. `splitCompanionSide` is the side the companion sits on
  // so focus can swap between panes without either jumping across the divider.
  splitCompanionId = $state<SessionId | null>(null);
  splitCompanionSide = $state<'left' | 'right'>('right');
  splitRatio = $state<number>(readSplitRatio());

  selected = $derived(
    this.selectedId ? this.sessions.find((s) => s.id === this.selectedId) ?? null : null
  );

  // Resolves the companion relationship into concrete left/right panes, but
  // only when both sessions are live in the same worktree. Anything stale
  // (a removed/stopped companion, a focus switch to another worktree) yields
  // null so the area falls back to a single pane.
  activeSplit = $derived.by<{
    leftId: SessionId;
    rightId: SessionId;
    focusedId: SessionId;
    leftTerminalId: string;
    rightTerminalId: string;
    ratio: number;
  } | null>(() => {
    const focused = this.selected;
    const companionId = this.splitCompanionId;
    if (!focused || !companionId || companionId === focused.id) return null;
    const companion = this.sessions.find((s) => s.id === companionId);
    if (!companion || !this.isSameWorktree(focused, companion)) return null;
    if (!this.isLive(focused.id) || !this.isLive(companionId)) return null;
    const companionLeft = this.splitCompanionSide === 'left';
    const leftId = companionLeft ? companionId : focused.id;
    const rightId = companionLeft ? focused.id : companionId;
    const leftTerminalId = this.runtime[leftId]?.terminalId ?? null;
    const rightTerminalId = this.runtime[rightId]?.terminalId ?? null;
    if (!leftTerminalId || !rightTerminalId) return null;
    return {
      leftId,
      rightId,
      focusedId: focused.id,
      leftTerminalId,
      rightTerminalId,
      ratio: this.splitRatio
    };
  });

  groups = $derived({
    claude: this.sessions.filter((s) => s.launch.type === 'agent' && s.launch.provider === 'claude_code'),
    codex: this.sessions.filter((s) => s.launch.type === 'agent' && s.launch.provider === 'codex'),
    terminal: this.sessions.filter((s) => s.launch.type === 'terminal')
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

  archivedByProject = $derived.by<Record<string, Session[]>>(() => {
    const out: Record<string, Session[]> = {};
    for (const session of this.archived) {
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

  lastSelectedByProject = $state<Record<string, SessionId>>(
    readLastSelectedMap(LAST_SELECTED_BY_PROJECT_KEY)
  );
  lastSelectedByWorktree = $state<Record<string, SessionId>>(
    readLastSelectedMap(LAST_SELECTED_BY_WORKTREE_KEY)
  );

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

  usageLimitFor(id: SessionId): ObservedAgentSnapshot['usageLimit'] | null {
    return this.observed[id]?.usageLimit ?? null;
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
      const [list, archived, running, observed] = await Promise.all([
        ipc.sessions.list(),
        ipc.sessions.listArchived(),
        ipc.terminal.listRunning(),
        ipc.observer.list()
      ]);
      this.sessions = list;
      this.archived = archived;
      const next: Record<SessionId, RuntimeEntry> = {};
      for (const r of running) next[r.sessionId] = { ...r };
      this.runtime = next;
      this.observed = Object.fromEntries(observed.map((s) => [s.id, s]));
      this.pruneLastSelected();
      if (!this.selectedId && list.length > 0) {
        this.selectedId = this.pickInitialSelection(list);
      }
      for (const snapshot of observed) {
        const rowSessionId = rowSessionIdFor(snapshot);
        const session = rowSessionId
          ? this.sessions.find((s) => s.id === rowSessionId) ?? null
          : null;
        agentNotifications.primeSnapshot(snapshot, session, this.selectedId);
      }
    } finally {
      this.loading = false;
    }
  }

  toggleArchivedFor(projectId: string): void {
    this.showArchivedFor = {
      ...this.showArchivedFor,
      [projectId]: !this.showArchivedFor[projectId]
    };
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
    const pruneMap = (map: Record<string, SessionId>): {
      next: Record<string, SessionId>;
      changed: boolean;
    } => {
      let changed = false;
      const next: Record<string, SessionId> = {};
      for (const [key, sessionId] of Object.entries(map)) {
        if (ids.has(sessionId)) {
          next[key] = sessionId;
        } else {
          changed = true;
        }
      }
      return { next, changed };
    };

    const project = pruneMap(this.lastSelectedByProject);
    if (project.changed) {
      this.lastSelectedByProject = project.next;
      writeLastSelectedMap(LAST_SELECTED_BY_PROJECT_KEY, project.next);
    }
    const worktree = pruneMap(this.lastSelectedByWorktree);
    if (worktree.changed) {
      this.lastSelectedByWorktree = worktree.next;
      writeLastSelectedMap(LAST_SELECTED_BY_WORKTREE_KEY, worktree.next);
    }
  }

  lastSelectedIdForWorktree(args: { projectId?: string | null; cwd: string }): SessionId | null {
    const projectId = args.projectId ?? null;
    const cwd = normPath(args.cwd);
    const candidates = this.sessions.filter(
      (s) => (s.projectId ?? null) === projectId && normPath(s.cwd) === cwd
    );
    if (candidates.length === 0) return null;
    const candidateIds = new Set(candidates.map((s) => s.id));
    for (const candidate of candidates) {
      const stored = this.lastSelectedByWorktree[worktreeSelectionKey(candidate)];
      if (stored && candidateIds.has(stored)) return stored;
    }
    return null;
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
      ipc.terminal.onLocation((event) => {
        void this.applyTerminalLocation(event.sessionId, event.cwd);
      })
    );
    this.detachers.push(
      ipc.observer.onSnapshot((snapshot) => {
        const rowSessionId = rowSessionIdFor(snapshot);
        const session = rowSessionId
          ? this.sessions.find((s) => s.id === rowSessionId) ?? null
          : null;
        agentNotifications.observeSnapshot(snapshot, session, this.selectedId);
        this.observed = { ...this.observed, [snapshot.id]: snapshot };
      })
    );
    this.detachers.push(
      ipc.observer.onEvent((event) => {
        const rowSessionId = this.rowSessionIdForEvent(event);
        const session = rowSessionId
          ? this.sessions.find((s) => s.id === rowSessionId) ?? null
          : null;
        agentNotifications.observeEvent(event, session, this.selectedId, rowSessionId);
        const current = this.observerEvents[event.subjectId] ?? [];
        this.observerEvents = {
          ...this.observerEvents,
          [event.subjectId]: [event, ...current].slice(0, 30)
        };
      })
    );
    this.detachers.push(
      ipc.notify.onActivateSession((sessionId) => {
        if (this.sessions.some((s) => s.id === sessionId)) this.select(sessionId);
      })
    );
    this.detachers.push(
      ipc.sessions.onChange((session) => {
        const idx = this.sessions.findIndex((s) => s.id === session.id);
        if (idx === -1) {
          this.sessions = [...this.sessions, session];
        } else {
          const next = [...this.sessions];
          next[idx] = session;
          this.sessions = next;
        }
      })
    );
  }

  private rowSessionIdForEvent(event: ObserverEvent): SessionId | null {
    const snapshot = this.observed[event.subjectId];
    if (snapshot) return rowSessionIdFor(snapshot);
    return this.sessions.some((s) => s.id === event.subjectId) ? event.subjectId : null;
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
    // New sessions get the highest sortIndex from the backend, so appending
    // here matches the persisted order. Selection routes through select()
    // so the rail fullscreen collapse stays consistent with manual switches.
    this.sessions = [...this.sessions, created];
    this.select(created.id);
    return created;
  }

  async createWithDefaults(opts: {
    projectId?: string;
    cwd?: string;
    branch?: string;
  } = {}): Promise<Session> {
    return this.createTypedWithDefaults('terminal', opts);
  }

  async createPreferredWithDefaults(opts: {
    projectId?: string;
    cwd?: string;
    branch?: string;
    runMode?: RunMode;
    wslDistro?: string;
  } = {}): Promise<Session> {
    return this.createTypedWithDefaults(settings.current.defaults.newSessionKind, opts);
  }

  async createAgentWithDefaults(
    kind: Extract<SessionLaunchKind, 'claude_code' | 'codex'>,
    opts: {
      projectId?: string;
      cwd?: string;
      branch?: string;
      model?: string;
      extraArgs?: string[];
    } = {}
  ): Promise<Session> {
    return this.createTypedWithDefaults(kind, opts);
  }

  async continueWithAgent(
    originId: SessionId,
    provider: AgentRuntimeProvider
  ): Promise<Session> {
    const origin = this.sessions.find((s) => s.id === originId);
    if (!origin) throw new Error(`Session not found: ${originId}`);
    const created = await this.createAgentWithDefaults(provider, {
      ...(origin.projectId ? { projectId: origin.projectId } : {}),
      cwd: origin.cwd,
      ...(origin.lastBranch ? { branch: origin.lastBranch } : {})
    });
    const terminalId = await this.waitForTerminalId(created.id, 5000);
    if (!terminalId) throw new Error(`Terminal did not start for ${created.name}`);
    await this.pasteContinuationPrompt(origin, terminalId);
    return created;
  }

  handoffTargetsFor(originId: SessionId, provider: AgentRuntimeProvider): Session[] {
    const origin = this.sessions.find((s) => s.id === originId);
    if (!origin) return [];
    return this.sessions.filter((candidate) =>
      candidate.id !== origin.id
      && this.isSameWorktree(origin, candidate)
      && this.agentProviderFor(candidate) === provider
    );
  }

  async continueInSession(originId: SessionId, targetId: SessionId): Promise<Session> {
    const origin = this.sessions.find((s) => s.id === originId);
    if (!origin) throw new Error(`Session not found: ${originId}`);
    const target = this.sessions.find((s) => s.id === targetId);
    if (!target) throw new Error(`Session not found: ${targetId}`);
    if (origin.id === target.id) throw new Error('Choose a different session to continue in');
    if (!this.isSameWorktree(origin, target)) {
      throw new Error('Choose a session in the same worktree');
    }
    if (!this.agentProviderFor(target)) {
      throw new Error('Choose a Claude Code or Codex session');
    }

    const terminalId = await this.ensureTerminalId(target.id);
    await this.pasteContinuationPrompt(origin, terminalId);
    this.select(target.id);
    return target;
  }

  private async createTypedWithDefaults(
    kind: SessionLaunchKind,
    opts: {
      projectId?: string;
      cwd?: string;
      branch?: string;
      model?: string;
      extraArgs?: string[];
      runMode?: RunMode;
      wslDistro?: string;
    } = {}
  ): Promise<Session> {
    const defaults = settings.current.defaults;
    const project = opts.projectId ? projects.get(opts.projectId) : null;
    // Explicit runMode/wslDistro (passed when splitting beside an existing
    // session) win over project/defaults so the new terminal lands in the
    // exact same worktree as its companion.
    const runMode = opts.runMode ?? project?.defaultRunMode ?? defaults.runMode;
    const cwd = opts.cwd ?? project?.path ?? normalizedDefaultCwd(defaults.cwd, runMode);
    const wslDistro = (() => {
      if (opts.wslDistro) return opts.wslDistro;
      if (project?.defaultWslDistro) return project.defaultWslDistro;
      return defaults.wslDistro ?? 'Ubuntu';
    })();
    const name = this.uniqueName(defaultSessionName(kind), opts.projectId);
    const base = {
      name,
      cwd,
      runMode,
      ...(runMode === 'wsl' ? { wslDistro } : {}),
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.branch ? { lastBranch: opts.branch } : {})
    };
    const draft: SessionDraft = (() => {
      switch (kind) {
        case 'terminal':
          return { ...base, launch: { type: 'terminal', shell: defaults.shell } };
        case 'claude_code':
          return {
            ...base,
            launch: {
              type: 'agent',
              provider: 'claude_code',
              resumeMode: 'new',
              fullscreenTui: true,
              ...(opts.model ? { model: opts.model } : {}),
              ...(opts.extraArgs?.length ? { extraArgs: opts.extraArgs } : {})
            }
          };
        case 'codex':
          return {
            ...base,
            launch: {
              type: 'agent',
              provider: 'codex',
              resumeMode: 'new',
              ...(opts.model ? { model: opts.model } : {}),
              ...(opts.extraArgs?.length ? { extraArgs: opts.extraArgs } : {})
            }
          };
      }
    })();
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

  async reorder(orderedIds: SessionId[]): Promise<void> {
    const list = await ipc.sessions.reorder(orderedIds);
    // Backend returns active (non-archived) sessions only. Replace in-store
    // state so the sidebar reflects the new order immediately.
    this.sessions = list;
  }

  async remove(id: SessionId): Promise<void> {
    this.clearSplitIfInvolves(id);
    const rt = this.runtime[id];
    if (rt && rt.terminalId && (rt.status === 'running' || rt.status === 'starting')) {
      try {
        await ipc.terminal.stop(rt.terminalId);
      } catch {
        // continue with delete even if stop fails
      }
    }
    const nextSelectedId = this.selectedId === id ? this.pickNextAfterRemoval(id) : null;
    await ipc.sessions.delete(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    agentNotifications.removeSession(id);
    const next = { ...this.runtime };
    delete next[id];
    this.runtime = next;
    const observed = { ...this.observed };
    delete observed[id];
    for (const snapshot of Object.values(observed)) {
      if (snapshot.originSessionId === id) delete observed[snapshot.id];
    }
    this.observed = observed;
    this.forgetLastSelectedId(id);
    if (this.selectedId === id) {
      if (nextSelectedId) this.select(nextSelectedId);
      else this.selectedId = null;
    }
  }

  async archive(id: SessionId): Promise<void> {
    this.clearSplitIfInvolves(id);
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
    const nextSelectedId = this.selectedId === id ? this.pickNextAfterRemoval(id) : null;
    const updated = await ipc.sessions.update(id, { archivedAt: new Date().toISOString() });
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.archived = [updated, ...this.archived.filter((s) => s.id !== id)];
    agentNotifications.removeSession(id);
    const next = { ...this.runtime };
    delete next[id];
    this.runtime = next;
    this.forgetLastSelectedId(id);
    if (this.selectedId === id) {
      if (nextSelectedId) this.select(nextSelectedId);
      else this.selectedId = null;
    }
  }

  private forgetLastSelectedId(id: SessionId): void {
    const project = dropSelectedId(this.lastSelectedByProject, id);
    if (project.changed) {
      this.lastSelectedByProject = project.next;
      writeLastSelectedMap(LAST_SELECTED_BY_PROJECT_KEY, project.next);
    }
    const worktree = dropSelectedId(this.lastSelectedByWorktree, id);
    if (worktree.changed) {
      this.lastSelectedByWorktree = worktree.next;
      writeLastSelectedMap(LAST_SELECTED_BY_WORKTREE_KEY, worktree.next);
    }
  }

  private pickNextAfterRemoval(removedId: SessionId): SessionId | null {
    const removedIndex = this.sessions.findIndex((s) => s.id === removedId);
    if (removedIndex < 0) return null;
    const removed = this.sessions[removedIndex]!;
    for (let i = removedIndex + 1; i < this.sessions.length; i += 1) {
      const s = this.sessions[i]!;
      if (this.isSameWorktree(removed, s)) return s.id;
    }
    for (let i = removedIndex - 1; i >= 0; i -= 1) {
      const s = this.sessions[i]!;
      if (this.isSameWorktree(removed, s)) return s.id;
    }
    return null;
  }

  async restore(id: SessionId): Promise<void> {
    const session = this.archived.find((s) => s.id === id);
    if (!session) return;
    const updated = await ipc.sessions.update(id, { archivedAt: undefined });
    this.archived = this.archived.filter((s) => s.id !== id);
    // Append so the restored row keeps its existing sortIndex position relative
    // to siblings; insertion order matches what the backend will send next.
    this.sessions = [...this.sessions.filter((s) => s.id !== id), updated];
  }

  async start(id: SessionId, opts: { focus?: boolean } = {}): Promise<void> {
    // `focus: false` starts a session without making it the focused pane —
    // used when adding a companion to the split so the current pane keeps focus.
    if (opts.focus !== false) this.select(id);
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

  private async waitForTerminalId(id: SessionId, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const terminalId = this.terminalIdFor(id);
      if (terminalId) return terminalId;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.terminalIdFor(id);
  }

  private async ensureTerminalId(id: SessionId): Promise<string> {
    const terminalId = this.terminalIdFor(id);
    if (terminalId) return terminalId;
    if (this.statusFor(id) === 'starting') {
      this.select(id);
    } else {
      await this.start(id);
    }
    const nextTerminalId = await this.waitForTerminalId(id, 5000);
    if (!nextTerminalId) {
      const session = this.sessions.find((s) => s.id === id);
      throw new Error(`Terminal did not start for ${session?.name ?? id}`);
    }
    return nextTerminalId;
  }

  private async pasteContinuationPrompt(origin: Session, terminalId: string): Promise<void> {
    await sendBracketedPaste(
      terminalId,
      continuationPrompt(origin, this.observationFor(origin.id)),
      true
    );
  }

  private isSameWorktree(a: Session, b: Session): boolean {
    return a.cwd === b.cwd
      && a.runMode === b.runMode
      && (a.wslDistro ?? null) === (b.wslDistro ?? null);
  }

  private agentProviderFor(session: Session): AgentRuntimeProvider | null {
    const observedProvider = this.observationFor(session.id)?.provider;
    if (observedProvider === 'claude_code' || observedProvider === 'codex') {
      return observedProvider;
    }
    return session.currentAgentRuntime?.provider ?? launchProvider(session);
  }

  async stopWorker(workerId: string): Promise<void> {
    const status = await ipc.observer.stopWorkerSession(workerId);
    if (status.snapshot) {
      this.observed = { ...this.observed, [status.snapshot.id]: status.snapshot };
    }
  }

  private isLive(id: SessionId): boolean {
    const rt = this.runtime[id];
    return !!rt?.terminalId && (rt.status === 'running' || rt.status === 'starting');
  }

  // Ctrl+Shift+/ — open a second pane running a new default-provider terminal
  // in the focused session's worktree. The existing session stays on the left
  // (it was already filling the area); the new one takes focus on the right.
  async splitNewTerminal(): Promise<Session> {
    const focused = this.selected;
    const canPair = !!focused && this.isLive(focused.id);
    const opts = focused
      ? {
          ...(focused.projectId ? { projectId: focused.projectId } : {}),
          cwd: focused.cwd,
          runMode: focused.runMode,
          ...(focused.wslDistro ? { wslDistro: focused.wslDistro } : {}),
          ...(focused.lastBranch ? { branch: focused.lastBranch } : {})
        }
      : {};
    const created = await this.createPreferredWithDefaults(opts);
    if (focused && canPair && created.id !== focused.id) {
      this.splitCompanionId = focused.id;
      this.splitCompanionSide = 'left';
    }
    return created;
  }

  // "Open beside current": keep the focused pane where it is and place the
  // target session in the right half, starting it if needed without stealing
  // focus.
  async addToSplit(targetId: SessionId): Promise<void> {
    const focused = this.selected;
    if (!focused || focused.id === targetId) return;
    const target = this.sessions.find((s) => s.id === targetId);
    if (!target || !this.isSameWorktree(focused, target)) return;
    if (!this.isLive(focused.id)) {
      this.select(targetId);
      return;
    }
    if (!this.isLive(targetId)) {
      await this.start(targetId, { focus: false });
    }
    this.splitCompanionId = targetId;
    this.splitCompanionSide = 'right';
  }

  // Collapse back to a single pane. Removing the focused half promotes the
  // companion to the sole, focused pane; removing the companion just drops it.
  removeFromSplit(id: SessionId): void {
    const companionId = this.splitCompanionId;
    if (!companionId) return;
    if (id === companionId) {
      this.clearSplitCompanion();
      return;
    }
    if (id === this.selectedId) {
      this.clearSplitCompanion();
      this.select(companionId);
    }
  }

  isInActiveSplit(id: SessionId): boolean {
    const split = this.activeSplit;
    return !!split && (split.leftId === id || split.rightId === id);
  }

  canAddToSplit(id: SessionId): boolean {
    const focused = this.selected;
    if (!focused || focused.id === id) return false;
    if (this.splitCompanionId === id) return false;
    if (!this.isLive(focused.id)) return false;
    const target = this.sessions.find((s) => s.id === id);
    if (!target) return false;
    return this.isSameWorktree(focused, target);
  }

  setSplitRatio(value: number): void {
    const next = clampSplitRatio(value);
    this.splitRatio = next;
    writeSplitRatio(next);
  }

  private clearSplitCompanion(): void {
    if (this.splitCompanionId === null) return;
    this.splitCompanionId = null;
    this.splitCompanionSide = 'right';
  }

  // Drop the split when either pane's session is being removed/archived so a
  // stale companion can't later resurrect a phantom split.
  private clearSplitIfInvolves(id: SessionId): void {
    if (this.splitCompanionId === id || this.selectedId === id) {
      this.clearSplitCompanion();
    }
  }

  // Keep the companion consistent as focus moves: selecting the companion
  // swaps the two panes (flipping the side so neither jumps); selecting a
  // session in another worktree drops the split entirely.
  private reconcileSplitOnSelect(prevId: SessionId | null, nextId: SessionId | null): void {
    const companionId = this.splitCompanionId;
    if (!companionId) return;
    if (nextId === null) {
      this.clearSplitCompanion();
      return;
    }
    if (nextId === companionId) {
      if (prevId && prevId !== companionId) {
        this.splitCompanionId = prevId;
        this.splitCompanionSide = this.splitCompanionSide === 'left' ? 'right' : 'left';
      } else {
        this.clearSplitCompanion();
      }
      return;
    }
    const next = this.sessions.find((s) => s.id === nextId);
    const companion = this.sessions.find((s) => s.id === companionId);
    if (!next || !companion || !this.isSameWorktree(next, companion)) {
      this.clearSplitCompanion();
    }
  }

  select(id: SessionId | null): void {
    const prevId = this.selectedId;
    this.reconcileSplitOnSelect(prevId, id);
    this.selectedId = id;
    // Any sidebar click should drop fullscreen so the user gets back to the
    // normal split-pane view — the rail covers the terminal when fullscreen
    // and clicking around the sidebar implies wanting to actually see/use
    // the destination session.
    if (id && id !== prevId) {
      rightRail.fullscreen = false;
    }
    if (id) {
      agentNotifications.markSessionOpened(id);
      const session = this.sessions.find((s) => s.id === id);
      if (session) {
        const key = session.projectId ?? STANDALONE_KEY;
        const nextMap = { ...this.lastSelectedByProject, [key]: id };
        this.lastSelectedByProject = nextMap;
        writeLastSelectedMap(LAST_SELECTED_BY_PROJECT_KEY, nextMap);

        const worktreeKey = worktreeSelectionKey(session);
        const nextWorktreeMap = { ...this.lastSelectedByWorktree, [worktreeKey]: id };
        this.lastSelectedByWorktree = nextWorktreeMap;
        writeLastSelectedMap(LAST_SELECTED_BY_WORKTREE_KEY, nextWorktreeMap);
      }
    }
  }
}

export const sessions = new SessionsStore();

function continuationPrompt(
  origin: Session,
  observed: ObservedAgentSnapshot | null
): string {
  const provider = origin.currentAgentRuntime?.provider ?? launchProvider(origin) ?? 'terminal';
  const handoffReason = (() => {
    if (observed?.state === 'usage_limited') {
      return 'The previous agent appears to have hit a usage limit.';
    }
    if (observed?.state === 'failed') {
      return 'The previous tab stopped before completing the task.';
    }
    return 'The user requested this handoff from another Soloe tab.';
  })();
  const lines = [
    'We are continuing from another Soloe tab.',
    handoffReason,
    '',
    'Continue the same task from that session. Preserve the user intent and current course of work.',
    'First inspect the raw session artifact if it is available, then continue from the latest useful state.',
    '',
    `Previous Soloe tab: ${origin.name || origin.id}`,
    `Previous provider: ${provider}`,
    `Working directory: ${origin.cwd}`,
    `Run mode: ${origin.runMode}${origin.wslDistro ? ` (${origin.wslDistro})` : ''}`,
    ...(origin.providerThreadId ? [`Provider session id: ${origin.providerThreadId}`] : []),
    ...(origin.transcriptPath ? [`Transcript/session JSON path: ${origin.transcriptPath}`] : []),
    ...(observed?.transcriptPath && observed.transcriptPath !== origin.transcriptPath
      ? [`Observed transcript path: ${observed.transcriptPath}`]
      : []),
    ...(observed?.usageLimit?.message ? [`Usage limit message: ${observed.usageLimit.message}`] : []),
    '',
    'If the raw artifact path is inaccessible, say what context is missing and ask for the smallest useful handoff instead of starting over.'
  ];
  return lines.join('\n');
}

function normalizedDefaultCwd(cwd: string, runMode: 'windows' | 'wsl'): string {
  if (runMode !== 'wsl') return cwd;
  if (/^\/mnt\/[a-z]\/Users\/[^/\\]+\/?$/i.test(cwd)) return '~';
  if (/^[a-z]:[\\/]+Users[\\/]+[^\\/]+[\\/]?$/i.test(cwd)) return '~';
  return cwd;
}

function defaultSessionName(kind: SessionLaunchKind): string {
  switch (kind) {
    case 'terminal':
      return randomName();
    case 'claude_code':
      return 'Claude';
    case 'codex':
      return 'Codex';
  }
}
