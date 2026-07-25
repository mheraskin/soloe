import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AgentLaunch,
  AgentRuntimeInfo,
  Session,
  SessionDraft,
  SessionId,
  SessionUpdate,
  ShellKind,
  TerminalLaunch
} from '@shared/types/sessions.js';
import { isSessionColor } from '@shared/types/sessions.js';
import { supportedRunModes, type SupportedHostPlatform } from '@shared/platform.js';

interface StorageShape {
  version: number;
  sessions: Session[];
}

type LegacySessionDraft = Omit<SessionDraft, 'launch'> & {
  launch?: never;
  kind: 'standard_terminal' | 'claude_code' | 'codex';
  shell?: ShellKind;
  command?: string;
  args?: string[];
  resumeMode?: AgentLaunch['resumeMode'];
  claudeSessionName?: string;
  claudeSessionId?: string;
  codexSessionId?: string;
  fullscreenTui?: boolean;
  model?: string;
  reasoningEffort?: AgentLaunch['reasoningEffort'];
  extraArgs?: string[];
};

const STORAGE_VERSION = 1;

export class SessionStore {
  private cache: Map<SessionId, Session> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly platform?: SupportedHostPlatform
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    if (this.cache) return;
    this.cache = await this.loadFromDisk();
    const assignedSortIndices = this.assignMissingSortIndices();
    if (assignedSortIndices) {
      await this.persist();
    }
  }

  async list(): Promise<Session[]> {
    await this.ensureLoaded();
    return [...this.cache!.values()]
      .filter((session) => !session.archivedAt)
      .sort(compareSessions);
  }

  async listArchived(): Promise<Session[]> {
    await this.ensureLoaded();
    return [...this.cache!.values()]
      .filter((session) => Boolean(session.archivedAt))
      .sort((a, b) =>
        (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')
      );
  }

  async get(id: SessionId): Promise<Session | null> {
    await this.ensureLoaded();
    return this.cache!.get(id) ?? null;
  }

  async create(draft: SessionDraft | LegacySessionDraft): Promise<Session> {
    await this.ensureLoaded();
    const normalizedDraft = normalizeSessionDraft(draft);
    const hasUserInput =
      normalizedDraft.hasUserInput ?? initialHasUserInput(normalizedDraft);
    const durableDraft = assignNewClaudeSessionId(normalizedDraft);
    const now = new Date().toISOString();
    const id = this.generateId(durableDraft.name);
    const session = {
      ...durableDraft,
      id,
      createdAt: now,
      lastUsedAt: now,
      sortIndex: this.nextSortIndex(),
      // New sessions are eligible for auto-rename until the user manually
      // edits the name (which sets autoNamed=false). Drafts may pre-set this
      // explicitly for tests or imports.
      autoNamed: durableDraft.autoNamed ?? true,
      hasUserInput
    } as Session;
    validateSession(session, this.platform);
    this.cache!.set(id, session);
    await this.persist();
    return session;
  }

  async update(id: SessionId, patch: SessionUpdate): Promise<Session> {
    await this.ensureLoaded();
    const existing = this.cache!.get(id);
    if (!existing) throw new Error(`Session not found: ${id}`);
    const merged = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt
    } as Session;
    validateSession(merged, this.platform);
    this.cache!.set(id, merged);
    await this.persist();
    return merged;
  }

  async delete(id: SessionId): Promise<void> {
    await this.ensureLoaded();
    // Idempotent: an absent session is already in the desired end-state (gone),
    // so deletion succeeds as a no-op. Throwing here would abort the caller's
    // teardown and strand a stale UI tab that can never be closed.
    if (this.cache!.delete(id)) {
      await this.persist();
    }
  }

  async touch(id: SessionId): Promise<Session | null> {
    await this.ensureLoaded();
    const existing = this.cache!.get(id);
    if (!existing) return null;
    const updated = { ...existing, lastUsedAt: new Date().toISOString() } as Session;
    this.cache!.set(id, updated);
    await this.persist();
    return updated;
  }

  async reorder(orderedIds: SessionId[]): Promise<Session[]> {
    await this.ensureLoaded();
    const seen = new Set<SessionId>();
    let nextIndex = 0;
    for (const id of orderedIds) {
      if (seen.has(id)) continue;
      const existing = this.cache!.get(id);
      if (!existing) continue;
      seen.add(id);
      this.cache!.set(id, { ...existing, sortIndex: nextIndex } as Session);
      nextIndex += 1;
    }
    for (const session of [...this.cache!.values()].sort(compareSessions)) {
      if (seen.has(session.id)) continue;
      this.cache!.set(session.id, { ...session, sortIndex: nextIndex } as Session);
      nextIndex += 1;
    }
    await this.persist();
    return this.list();
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.cache) await this.init();
  }

  private nextSortIndex(): number {
    let max = -1;
    for (const session of this.cache!.values()) {
      if (Number.isFinite(session.sortIndex) && (session.sortIndex as number) > max) {
        max = session.sortIndex as number;
      }
    }
    return max + 1;
  }

  // One-shot migration: seed sortIndex from the prior createdAt-asc order so
  // pre-existing sessions don't reshuffle the first time the user runs a
  // build that has reorder enabled.
  private assignMissingSortIndices(): boolean {
    if (!this.cache) return false;
    const all = [...this.cache.values()];
    const missing = all.filter((s) => !Number.isFinite(s.sortIndex));
    if (missing.length === 0) return false;
    const ordered = [...all].sort((a, b) => {
      const aHas = Number.isFinite(a.sortIndex);
      const bHas = Number.isFinite(b.sortIndex);
      if (aHas && bHas) return (a.sortIndex as number) - (b.sortIndex as number);
      if (aHas) return -1;
      if (bHas) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
    let next = 0;
    for (const session of ordered) {
      this.cache.set(session.id, { ...session, sortIndex: next } as Session);
      next += 1;
    }
    return true;
  }

  private async loadFromDisk(): Promise<Map<SessionId, Session>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map();
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      await this.backupCorruptFile(raw);
      return new Map();
    }
    const sessions = parseStorage(parsed, this.platform);
    return new Map(sessions.map((s) => [s.id, s]));
  }

  private async backupCorruptFile(content: string): Promise<void> {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      await fs.writeFile(backupPath, content, 'utf8');
    } catch {
      // best-effort backup
    }
  }

  private async persist(): Promise<void> {
    const snapshot: StorageShape = {
      version: STORAGE_VERSION,
      sessions: [...this.cache!.values()]
    };
    const payload = JSON.stringify(snapshot, null, 2);
    this.writeQueue = this.writeQueue.then(() => atomicWrite(this.filePath, payload));
    await this.writeQueue;
  }

  private generateId(name: string): SessionId {
    const slug = slugify(name) || 'session';
    let candidate = slug;
    let attempt = 0;
    while (this.cache!.has(candidate)) {
      attempt += 1;
      candidate = `${slug}-${randomBytes(3).toString('hex')}`;
      if (attempt > 10) {
        candidate = `${slug}-${Date.now()}`;
        break;
      }
    }
    return candidate;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function parseStorage(raw: unknown, platform?: SupportedHostPlatform): Session[] {
  if (!isObject(raw)) return [];
  const sessionsRaw = raw['sessions'];
  if (!Array.isArray(sessionsRaw)) return [];
  const valid: Session[] = [];
  for (const candidate of sessionsRaw) {
    const session = parseSession(candidate, platform);
    if (session) valid.push(session);
  }
  return valid;
}

function parseSession(raw: unknown, platform?: SupportedHostPlatform): Session | null {
  if (!isObject(raw)) return null;
  if (typeof raw['id'] !== 'string') return null;
  if (typeof raw['name'] !== 'string') return null;
  if (typeof raw['cwd'] !== 'string') return null;
  const runMode = raw['runMode'];
  if (runMode !== 'windows' && runMode !== 'linux' && runMode !== 'wsl') return null;
  if (typeof raw['createdAt'] !== 'string') return null;
  if (typeof raw['lastUsedAt'] !== 'string') return null;
  const session = migrateRawSession(raw);
  if (!session) return null;
  try {
    validateSession(session, platform);
    return session;
  } catch {
    return null;
  }
}

function validateSession(s: Session, platform?: SupportedHostPlatform): void {
  if (!s.name.trim()) throw new Error('Session name is required');
  if (!s.cwd.trim()) throw new Error('Session cwd is required');
  if (s.runMode === 'wsl' && !s.wslDistro) {
    throw new Error('wslDistro is required when runMode is wsl');
  }
  if (platform && !supportedRunModes(platform).includes(s.runMode)) {
    throw new Error(`Run mode ${s.runMode} is not available on ${platform}`);
  }
  if (s.projectId !== undefined && (typeof s.projectId !== 'string' || !s.projectId.trim())) {
    throw new Error('projectId must be a non-empty string when set');
  }
  if (s.tags !== undefined) {
    if (!Array.isArray(s.tags) || s.tags.some((t) => typeof t !== 'string')) {
      throw new Error('tags must be an array of strings when set');
    }
  }
  if (s.pinned !== undefined && typeof s.pinned !== 'boolean') {
    throw new Error('pinned must be a boolean when set');
  }
  if (s.archivedAt !== undefined && typeof s.archivedAt !== 'string') {
    throw new Error('archivedAt must be a string when set');
  }
  if (s.lastBranch !== undefined && typeof s.lastBranch !== 'string') {
    throw new Error('lastBranch must be a string when set');
  }
  if (s.sortIndex !== undefined && !Number.isFinite(s.sortIndex)) {
    throw new Error('sortIndex must be a finite number when set');
  }
  if (s.color !== undefined && !isSessionColor(s.color)) {
    throw new Error('color must be a known SessionColor token when set');
  }
  if (s.autoNamed !== undefined && typeof s.autoNamed !== 'boolean') {
    throw new Error('autoNamed must be a boolean when set');
  }
  if (s.hasUserInput !== undefined && typeof s.hasUserInput !== 'boolean') {
    throw new Error('hasUserInput must be a boolean when set');
  }
  if (s.currentAgentRuntime !== undefined) {
    const runtime = s.currentAgentRuntime;
    if (runtime.provider !== 'claude_code' && runtime.provider !== 'codex') {
      throw new Error('currentAgentRuntime.provider must be a known agent provider');
    }
    if (runtime.status !== 'active' && runtime.status !== 'exited') {
      throw new Error('currentAgentRuntime.status must be active or exited');
    }
    if (runtime.providerThreadId !== undefined && typeof runtime.providerThreadId !== 'string') {
      throw new Error('currentAgentRuntime.providerThreadId must be a string when set');
    }
    if (runtime.startedAt !== undefined && typeof runtime.startedAt !== 'string') {
      throw new Error('currentAgentRuntime.startedAt must be a string when set');
    }
    if (runtime.lastEventAt !== undefined && typeof runtime.lastEventAt !== 'string') {
      throw new Error('currentAgentRuntime.lastEventAt must be a string when set');
    }
  }
  if (!s.launch || typeof s.launch !== 'object') {
    throw new Error('launch is required');
  }
  switch (s.launch.type) {
    case 'terminal':
      if (!s.launch.shell) throw new Error('shell is required for terminal launch');
      if (s.launch.shell === 'custom' && !s.launch.command) {
        throw new Error('command is required when shell is custom');
      }
      break;
    case 'agent':
      if (s.launch.provider !== 'claude_code' && s.launch.provider !== 'codex') {
        throw new Error('launch.provider must be a known agent provider');
      }
      if (s.launch.provider === 'claude_code' && !isClaudeResumeMode(s.launch.resumeMode)) {
        throw new Error('resumeMode must be a known Claude resume mode');
      }
      if (s.launch.provider === 'codex' && !isCodexResumeMode(s.launch.resumeMode)) {
        throw new Error('resumeMode must be a known Codex resume mode');
      }
      if (s.launch.provider === 'claude_code' && s.launch.resumeMode === 'resume_by_name' && !s.launch.claudeSessionName) {
        throw new Error('claudeSessionName is required for resume_by_name');
      }
      if (s.launch.provider === 'claude_code' && s.launch.resumeMode === 'resume_by_id' && !s.launch.claudeSessionId) {
        throw new Error('claudeSessionId is required for resume_by_id');
      }
      if (s.launch.provider === 'codex' && s.launch.resumeMode === 'resume_by_id' && !s.launch.codexSessionId) {
        throw new Error('codexSessionId is required for resume_by_id');
      }
      if (s.launch.extraArgs !== undefined && !isStringArray(s.launch.extraArgs)) {
        throw new Error('extraArgs must be an array of strings when set');
      }
      break;
    default:
      throw new Error('launch.type must be terminal or agent');
  }
}

function initialHasUserInput(draft: SessionDraft): boolean | undefined {
  if (draft.launch.type !== 'agent' || draft.launch.provider !== 'claude_code') return undefined;
  if (draft.launch.resumeMode !== 'new') return undefined;
  if (draft.launch.claudeSessionId || draft.providerThreadId) return undefined;
  return false;
}

function assignNewClaudeSessionId(draft: SessionDraft): SessionDraft {
  if (draft.launch.type !== 'agent' || draft.launch.provider !== 'claude_code') return draft;
  if (draft.launch.resumeMode !== 'new') return draft;
  if (draft.launch.claudeSessionId || draft.providerThreadId) return draft;
  return {
    ...draft,
    launch: {
      ...draft.launch,
      claudeSessionId: randomUUID()
    }
  };
}

function normalizeSessionDraft(draft: SessionDraft | LegacySessionDraft): SessionDraft {
  if (draft.launch) return draft as SessionDraft;
  const raw = draft as unknown as Record<string, unknown>;
  const launch = parseLaunch(raw);
  if (!launch) return draft as unknown as SessionDraft;
  const {
    kind: _kind,
    shell: _shell,
    command: _command,
    args: _args,
    resumeMode: _resumeMode,
    claudeSessionName: _claudeSessionName,
    claudeSessionId: _claudeSessionId,
    codexSessionId: _codexSessionId,
    fullscreenTui: _fullscreenTui,
    model: _model,
    reasoningEffort: _reasoningEffort,
    extraArgs: _extraArgs,
    ...rest
  } = raw;
  return { ...rest, launch } as unknown as SessionDraft;
}

function migrateRawSession(raw: Record<string, unknown>): Session | null {
  const launch = parseLaunch(raw);
  if (!launch) return null;
  const {
    kind: _kind,
    shell: _shell,
    command: _command,
    args: _args,
    resumeMode: _resumeMode,
    claudeSessionName: _claudeSessionName,
    claudeSessionId: _claudeSessionId,
    codexSessionId: _codexSessionId,
    fullscreenTui: _fullscreenTui,
    model: _model,
    reasoningEffort: _reasoningEffort,
    extraArgs: _extraArgs,
    currentAgentRuntime: rawRuntime,
    ...rest
  } = raw;
  const runtime = parseCurrentAgentRuntime(rawRuntime);
  return {
    ...rest,
    launch,
    ...(runtime ? { currentAgentRuntime: runtime } : {})
  } as unknown as Session;
}

function parseCurrentAgentRuntime(raw: unknown): AgentRuntimeInfo | null {
  if (!isObject(raw)) return null;
  const provider = raw['provider'];
  const status = raw['status'];
  if (provider !== 'claude_code' && provider !== 'codex') return null;
  if (status !== 'active' && status !== 'exited') return null;
  return {
    provider,
    status,
    ...(typeof raw['providerThreadId'] === 'string' ? { providerThreadId: raw['providerThreadId'] } : {}),
    ...(typeof raw['startedAt'] === 'string' ? { startedAt: raw['startedAt'] } : {}),
    ...(typeof raw['lastEventAt'] === 'string' ? { lastEventAt: raw['lastEventAt'] } : {})
  };
}

function parseLaunch(raw: Record<string, unknown>): TerminalLaunch | AgentLaunch | null {
  const existing = raw['launch'];
  if (isObject(existing)) {
    const type = existing['type'];
    if (type === 'terminal') {
      const shell = existing['shell'];
      if (!isShell(shell)) return null;
      return {
        type: 'terminal',
        shell,
        ...(typeof existing['command'] === 'string' ? { command: existing['command'] } : {}),
        ...(Array.isArray(existing['args']) && existing['args'].every((arg) => typeof arg === 'string')
          ? { args: existing['args'] as string[] }
          : {})
      };
    }
    if (type === 'agent') {
      const provider = existing['provider'];
      if (provider !== 'claude_code' && provider !== 'codex') return null;
      return {
        type: 'agent',
        provider,
        resumeMode: typeof existing['resumeMode'] === 'string' ? existing['resumeMode'] as AgentLaunch['resumeMode'] : 'new',
        ...(typeof existing['claudeSessionName'] === 'string' ? { claudeSessionName: existing['claudeSessionName'] } : {}),
        ...(typeof existing['claudeSessionId'] === 'string' ? { claudeSessionId: existing['claudeSessionId'] } : {}),
        ...(typeof existing['codexSessionId'] === 'string' ? { codexSessionId: existing['codexSessionId'] } : {}),
        ...(typeof existing['fullscreenTui'] === 'boolean' ? { fullscreenTui: existing['fullscreenTui'] } : {}),
        ...(typeof existing['model'] === 'string' ? { model: existing['model'] } : {}),
        ...(isCodexReasoningEffort(existing['reasoningEffort']) ? { reasoningEffort: existing['reasoningEffort'] } : {}),
        ...(isStringArray(existing['extraArgs']) ? { extraArgs: existing['extraArgs'] } : {})
      };
    }
  }

  // TODO: remove after a few releases once stored sessions have been rewritten
  // with launch metadata instead of the legacy top-level kind/shell fields.
  switch (raw['kind']) {
    case 'standard_terminal': {
      const shell = raw['shell'];
      if (!isShell(shell)) return null;
      return {
        type: 'terminal',
        shell,
        ...(typeof raw['command'] === 'string' ? { command: raw['command'] } : {}),
        ...(Array.isArray(raw['args']) && raw['args'].every((arg) => typeof arg === 'string')
          ? { args: raw['args'] as string[] }
          : {})
      };
    }
    case 'claude_code':
      return {
        type: 'agent',
        provider: 'claude_code',
        resumeMode: typeof raw['resumeMode'] === 'string' ? raw['resumeMode'] as AgentLaunch['resumeMode'] : 'new',
        ...(typeof raw['claudeSessionName'] === 'string' ? { claudeSessionName: raw['claudeSessionName'] } : {}),
        ...(typeof raw['claudeSessionId'] === 'string' ? { claudeSessionId: raw['claudeSessionId'] } : {}),
        ...(typeof raw['fullscreenTui'] === 'boolean' ? { fullscreenTui: raw['fullscreenTui'] } : {}),
        ...(typeof raw['model'] === 'string' ? { model: raw['model'] } : {}),
        ...(isStringArray(raw['extraArgs']) ? { extraArgs: raw['extraArgs'] } : {})
      };
    case 'codex':
      return {
        type: 'agent',
        provider: 'codex',
        resumeMode: typeof raw['resumeMode'] === 'string' ? raw['resumeMode'] as AgentLaunch['resumeMode'] : 'new',
        ...(typeof raw['codexSessionId'] === 'string' ? { codexSessionId: raw['codexSessionId'] } : {}),
        ...(typeof raw['model'] === 'string' ? { model: raw['model'] } : {}),
        ...(isCodexReasoningEffort(raw['reasoningEffort']) ? { reasoningEffort: raw['reasoningEffort'] } : {}),
        ...(isStringArray(raw['extraArgs']) ? { extraArgs: raw['extraArgs'] } : {})
      };
    default:
      return null;
  }
}

function isShell(value: unknown): value is ShellKind {
  return value === 'auto' || value === 'bash' || value === 'zsh'
    || value === 'pwsh' || value === 'cmd' || value === 'custom';
}

function isClaudeResumeMode(value: unknown): boolean {
  return value === 'new' || value === 'resume_by_name'
    || value === 'resume_by_id' || value === 'resume_last';
}

function isCodexResumeMode(value: unknown): boolean {
  return value === 'new' || value === 'resume_by_id' || value === 'resume_last';
}

function isCodexReasoningEffort(value: unknown): value is 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function compareSessions(a: Session, b: Session): number {
  const ai = sortKey(a);
  const bi = sortKey(b);
  if (ai !== bi) return ai - bi;
  return a.createdAt.localeCompare(b.createdAt);
}

function sortKey(s: Session): number {
  return Number.isFinite(s.sortIndex) ? (s.sortIndex as number) : Number.MAX_SAFE_INTEGER;
}
