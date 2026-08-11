import type { SessionId, AgentRuntimeProvider } from '@shared/types/sessions.js';
import { worktreeScopeKey, type WorktreeScope } from '@shared/worktree-identity.js';

// Per-worktree registry of named agents that have been mentioned in diff
// comments. An agent is created the first time the user picks "new claude",
// "new codex", or a specific model from the @-mention picker; once a comment
// references it by name, future comments in the same worktree can reuse it
// from autocomplete. Agents that are no longer mentioned by any comment get
// pruned by `pruneUnreferenced`.
export interface CommentAgent {
  id: string;
  scope: WorktreeScope;
  name: string;
  provider: AgentRuntimeProvider;
  // When set, a specific model id from the catalog (e.g. 'gpt-5.4-mini',
  // 'sonnet'). When undefined, the user picked the provider's default.
  model?: string;
  // The session this agent was spawned into, if it has been spawned yet.
  // Stage 3 fills this in on first send.
  spawnedSessionId?: SessionId;
  createdAt: number;
}

// v1 was keyed only by cwd. It cannot be assigned to a WSL distribution
// safely, so leave it untouched instead of silently adopting it into one
// runtime's registry.
const STORAGE_KEY = 'soloe.commentAgents.v2';
const LEGACY_STORAGE_KEY = 'soloe.commentAgents.v1';

function loadFromStorage(): Record<string, CommentAgent[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, CommentAgent[]> = {};
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        for (const candidate of value) {
          if (!isPersistedAgent(candidate)) continue;
          const key = worktreeScopeKey(candidate.scope);
          out[key] = [...(out[key] ?? []), candidate];
        }
      }
      return out;
    }
  } catch {
    // ignore corrupt storage
  }
  return {};
}

function isPersistedAgent(value: unknown): value is CommentAgent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<CommentAgent>;
  const scope = candidate.scope;
  return Boolean(
    scope &&
      typeof scope === 'object' &&
      typeof scope.cwd === 'string' &&
      scope.cwd.trim() &&
      (scope.runMode === 'windows' || scope.runMode === 'linux' ||
        (scope.runMode === 'wsl' &&
          typeof scope.wslDistro === 'string' &&
          scope.wslDistro.trim())) &&
      typeof candidate.id === 'string' &&
      typeof candidate.name === 'string' &&
      (candidate.provider === 'claude_code' || candidate.provider === 'codex') &&
      typeof candidate.createdAt === 'number'
  );
}

type LegacyCommentAgent = Omit<CommentAgent, 'scope'> & { cwd: string };

function isLegacyAgent(value: unknown): value is LegacyCommentAgent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<LegacyCommentAgent>;
  return Boolean(
    typeof candidate.id === 'string' &&
      typeof candidate.cwd === 'string' &&
      candidate.cwd.trim() &&
      typeof candidate.name === 'string' &&
      (candidate.provider === 'claude_code' || candidate.provider === 'codex') &&
      typeof candidate.createdAt === 'number'
  );
}

function loadLegacyFromStorage(): Record<string, LegacyCommentAgent[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, LegacyCommentAgent[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const agents = value.filter(isLegacyAgent);
      if (agents.length > 0) out[key] = agents;
    }
    return out;
  } catch {
    return {};
  }
}

export class CommentAgentsStore {
  byScope = $state<Record<string, CommentAgent[]>>(loadFromStorage());
  legacyByCwd = $state<Record<string, LegacyCommentAgent[]>>(loadLegacyFromStorage());

  forScope(scope: WorktreeScope): CommentAgent[] {
    return this.byScope[worktreeScopeKey(scope)] ?? [];
  }

  byName(scope: WorktreeScope, name: string): CommentAgent | null {
    const lower = name.toLowerCase();
    return this.forScope(scope).find((a) => a.name.toLowerCase() === lower) ?? null;
  }

  byId(id: string): CommentAgent | null {
    for (const list of Object.values(this.byScope)) {
      const found = list.find((a) => a.id === id);
      if (found) return found;
    }
    return null;
  }

  adoptLegacy(scope: WorktreeScope): number {
    const legacy = Object.values(this.legacyByCwd)
      .flat()
      .filter((agent) => agent.cwd === scope.cwd);
    if (legacy.length === 0) return 0;
    const key = worktreeScopeKey(scope);
    const scoped = [...(this.byScope[key] ?? [])];
    const names = new Set(scoped.map((agent) => agent.name.toLowerCase()));
    const ids = new Set(scoped.map((agent) => agent.id));
    for (const agent of legacy) {
      if (names.has(agent.name.toLowerCase()) || ids.has(agent.id)) continue;
      const { cwd: _legacyCwd, ...rest } = agent;
      scoped.push({ ...rest, scope });
      names.add(agent.name.toLowerCase());
      ids.add(agent.id);
    }
    const nextLegacy: Record<string, LegacyCommentAgent[]> = {};
    for (const [legacyKey, agents] of Object.entries(this.legacyByCwd)) {
      const remaining = agents.filter((agent) => agent.cwd !== scope.cwd);
      if (remaining.length > 0) nextLegacy[legacyKey] = remaining;
    }
    this.byScope = { ...this.byScope, [key]: scoped };
    this.legacyByCwd = nextLegacy;
    this.persist();
    this.persistLegacy();
    return legacy.length;
  }

  create(input: {
    scope: WorktreeScope;
    name: string;
    provider: AgentRuntimeProvider;
    model?: string;
  }): CommentAgent {
    const agent: CommentAgent = {
      id: crypto.randomUUID(),
      scope: input.scope,
      name: this.uniqueName(input.scope, input.name),
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      createdAt: Date.now()
    };
    const key = worktreeScopeKey(input.scope);
    const list = this.byScope[key] ?? [];
    this.byScope = { ...this.byScope, [key]: [...list, agent] };
    this.persist();
    return agent;
  }

  update(
    id: string,
    patch: Partial<Omit<CommentAgent, 'id' | 'scope' | 'createdAt'>>
  ): void {
    let touched = false;
    const next: Record<string, CommentAgent[]> = {};
    for (const [scopeKey, list] of Object.entries(this.byScope)) {
      next[scopeKey] = list.map((a) => {
        if (a.id !== id) return a;
        touched = true;
        return { ...a, ...patch };
      });
    }
    if (touched) {
      this.byScope = next;
      this.persist();
    }
  }

  remove(id: string): void {
    let touched = false;
    const next: Record<string, CommentAgent[]> = {};
    for (const [scopeKey, list] of Object.entries(this.byScope)) {
      const filtered = list.filter((a) => a.id !== id);
      if (filtered.length !== list.length) touched = true;
      next[scopeKey] = filtered;
    }
    if (touched) {
      this.byScope = next;
      this.persist();
    }
  }

  // Drops agents in the given cwd whose names are not mentioned by any of the
  // provided comment texts. Called by the comments flow after a save so the
  // registry stays in sync with what is actually referenced.
  pruneUnreferenced(scope: WorktreeScope, mentionedNames: string[]): void {
    const key = worktreeScopeKey(scope);
    const list = this.byScope[key];
    if (!list || list.length === 0) return;
    const keep = new Set(mentionedNames.map((n) => n.toLowerCase()));
    const filtered = list.filter((a) => keep.has(a.name.toLowerCase()));
    if (filtered.length === list.length) return;
    this.byScope = { ...this.byScope, [key]: filtered };
    this.persist();
  }

  // Generates a name not yet taken in the cwd. If `base` is free, returns it
  // as-is; otherwise appends -2, -3, … until one is free.
  uniqueName(scope: WorktreeScope, base: string): string {
    const taken = new Set(this.forScope(scope).map((a) => a.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.byScope));
    } catch {
      // ignore
    }
  }

  private persistLegacy(): void {
    try {
      localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(this.legacyByCwd));
    } catch {
      // ignore
    }
  }
}

export const commentAgents = new CommentAgentsStore();

// Returns the unique set of `@name` tokens in a comment body, in first-seen
// order. Names are matched as `[\w-]+` after `@` and must be preceded by
// start-of-string or whitespace so email-like substrings don't trip the
// parser. Comparison is case-insensitive on the dedup side.
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\s)@([\w-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export interface MentionContext {
  // The `@`'s position in the textarea value (caret-relative).
  start: number;
  // Position immediately after the last name char, == cursor when active.
  end: number;
  // The query the user has typed after `@`, possibly empty right after `@`.
  query: string;
}

// Detects whether the cursor is currently inside a `@…` token that should
// open the picker. Returns null when the cursor isn't on a mention. The token
// must be preceded by start-of-string or whitespace; we walk back from the
// cursor until we hit `@` or a delimiter.
export function detectMentionAtCursor(text: string, cursor: number): MentionContext | null {
  if (cursor < 0 || cursor > text.length) return null;
  let i = cursor - 1;
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === '@') {
      const prev = i === 0 ? '' : text[i - 1] ?? '';
      if (prev !== '' && !/\s/.test(prev)) return null;
      const query = text.slice(i + 1, cursor);
      if (!/^[\w-]*$/.test(query)) return null;
      return { start: i, end: cursor, query };
    }
    if (!/[\w-]/.test(ch)) return null;
    i -= 1;
  }
  return null;
}
