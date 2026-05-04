import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  Session,
  SessionDraft,
  SessionId,
  SessionUpdate,
  SessionKind
} from '@shared/types/sessions.js';
import { isSessionColor } from '@shared/types/sessions.js';

interface StorageShape {
  version: number;
  sessions: Session[];
}

const STORAGE_VERSION = 1;
const VALID_KINDS: SessionKind[] = ['standard_terminal', 'claude_code', 'codex'];

export class SessionStore {
  private cache: Map<SessionId, Session> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    if (this.cache) return;
    this.cache = await this.loadFromDisk();
    const pruned = this.pruneKnownEmptyClaudeSessions();
    const assignedSortIndices = this.assignMissingSortIndices();
    const changed = pruned || assignedSortIndices;
    if (changed) {
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

  async create(draft: SessionDraft): Promise<Session> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const id = this.generateId(draft.name);
    const session = {
      ...draft,
      id,
      createdAt: now,
      lastUsedAt: now,
      sortIndex: this.nextSortIndex(),
      // New sessions are eligible for auto-rename until the user manually
      // edits the name (which sets autoNamed=false). Drafts may pre-set this
      // explicitly for tests or imports.
      autoNamed: draft.autoNamed ?? true,
      hasUserInput: draft.hasUserInput ?? initialHasUserInput(draft)
    } as Session;
    validateSession(session);
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
      kind: existing.kind,
      createdAt: existing.createdAt
    } as Session;
    validateSession(merged);
    this.cache!.set(id, merged);
    await this.persist();
    return merged;
  }

  async delete(id: SessionId): Promise<void> {
    await this.ensureLoaded();
    if (!this.cache!.delete(id)) {
      throw new Error(`Session not found: ${id}`);
    }
    await this.persist();
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

  private pruneKnownEmptyClaudeSessions(): boolean {
    if (!this.cache) return false;
    let changed = false;
    for (const session of this.cache.values()) {
      if (session.kind !== 'claude_code' || session.hasUserInput !== false) continue;
      this.cache.delete(session.id);
      changed = true;
    }
    return changed;
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
    const sessions = parseStorage(parsed);
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
      sessions: [...this.cache!.values()].filter((session) => !isKnownEmptyClaudeSession(session))
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

function parseStorage(raw: unknown): Session[] {
  if (!isObject(raw)) return [];
  const sessionsRaw = raw['sessions'];
  if (!Array.isArray(sessionsRaw)) return [];
  const valid: Session[] = [];
  for (const candidate of sessionsRaw) {
    const session = parseSession(candidate);
    if (session) valid.push(session);
  }
  return valid;
}

function parseSession(raw: unknown): Session | null {
  if (!isObject(raw)) return null;
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !VALID_KINDS.includes(kind as SessionKind)) return null;
  if (typeof raw['id'] !== 'string') return null;
  if (typeof raw['name'] !== 'string') return null;
  if (typeof raw['cwd'] !== 'string') return null;
  const runMode = raw['runMode'];
  if (runMode !== 'windows' && runMode !== 'wsl') return null;
  if (typeof raw['createdAt'] !== 'string') return null;
  if (typeof raw['lastUsedAt'] !== 'string') return null;
  const session = raw as unknown as Session;
  try {
    validateSession(session);
    return session;
  } catch {
    return null;
  }
}

function validateSession(s: Session): void {
  if (!s.name.trim()) throw new Error('Session name is required');
  if (!s.cwd.trim()) throw new Error('Session cwd is required');
  if (s.runMode === 'wsl' && !s.wslDistro) {
    throw new Error('wslDistro is required when runMode is wsl');
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
    if (runtime.source !== 'managed' && runtime.source !== 'attached') {
      throw new Error('currentAgentRuntime.source must be managed or attached');
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
  switch (s.kind) {
    case 'standard_terminal':
      if (!s.shell) throw new Error('shell is required for standard_terminal');
      if (s.shell === 'custom' && !s.command) {
        throw new Error('command is required when shell is custom');
      }
      break;
    case 'claude_code':
      if (s.resumeMode === 'resume_by_name' && !s.claudeSessionName) {
        throw new Error('claudeSessionName is required for resume_by_name');
      }
      if (s.resumeMode === 'resume_by_id' && !s.claudeSessionId) {
        throw new Error('claudeSessionId is required for resume_by_id');
      }
      break;
    case 'codex':
      if (s.resumeMode === 'resume_by_id' && !s.codexSessionId) {
        throw new Error('codexSessionId is required for resume_by_id');
      }
      break;
  }
}

function initialHasUserInput(draft: SessionDraft): boolean | undefined {
  if (draft.kind !== 'claude_code') return undefined;
  if (draft.resumeMode !== 'new') return undefined;
  if (draft.claudeSessionId || draft.providerThreadId) return undefined;
  return false;
}

function isKnownEmptyClaudeSession(session: Session): boolean {
  return session.kind === 'claude_code' && session.hasUserInput === false;
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
