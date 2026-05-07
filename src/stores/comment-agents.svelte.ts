import type { SessionId, AgentRuntimeProvider } from '@shared/types/sessions.js';

// Per-worktree registry of named agents that have been mentioned in diff
// comments. An agent is created the first time the user picks "new claude",
// "new codex", or a specific model from the @-mention picker; once a comment
// references it by name, future comments in the same worktree can reuse it
// from autocomplete. Agents that are no longer mentioned by any comment get
// pruned by `pruneUnreferenced`.
export interface CommentAgent {
  id: string;
  cwd: string;
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

const STORAGE_KEY = 'soloe.commentAgents.v1';

function loadFromStorage(): Record<string, CommentAgent[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, CommentAgent[]> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(value)) out[key] = value as CommentAgent[];
      }
      return out;
    }
  } catch {
    // ignore corrupt storage
  }
  return {};
}

class CommentAgentsStore {
  byCwd = $state<Record<string, CommentAgent[]>>(loadFromStorage());

  forCwd(cwd: string): CommentAgent[] {
    return this.byCwd[cwd] ?? [];
  }

  byName(cwd: string, name: string): CommentAgent | null {
    const lower = name.toLowerCase();
    return this.forCwd(cwd).find((a) => a.name.toLowerCase() === lower) ?? null;
  }

  byId(id: string): CommentAgent | null {
    for (const list of Object.values(this.byCwd)) {
      const found = list.find((a) => a.id === id);
      if (found) return found;
    }
    return null;
  }

  create(input: {
    cwd: string;
    name: string;
    provider: AgentRuntimeProvider;
    model?: string;
  }): CommentAgent {
    const agent: CommentAgent = {
      id: crypto.randomUUID(),
      cwd: input.cwd,
      name: this.uniqueName(input.cwd, input.name),
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      createdAt: Date.now()
    };
    const list = this.byCwd[input.cwd] ?? [];
    this.byCwd = { ...this.byCwd, [input.cwd]: [...list, agent] };
    this.persist();
    return agent;
  }

  update(id: string, patch: Partial<Omit<CommentAgent, 'id' | 'cwd' | 'createdAt'>>): void {
    let touched = false;
    const next: Record<string, CommentAgent[]> = {};
    for (const [cwd, list] of Object.entries(this.byCwd)) {
      next[cwd] = list.map((a) => {
        if (a.id !== id) return a;
        touched = true;
        return { ...a, ...patch };
      });
    }
    if (touched) {
      this.byCwd = next;
      this.persist();
    }
  }

  remove(id: string): void {
    let touched = false;
    const next: Record<string, CommentAgent[]> = {};
    for (const [cwd, list] of Object.entries(this.byCwd)) {
      const filtered = list.filter((a) => a.id !== id);
      if (filtered.length !== list.length) touched = true;
      next[cwd] = filtered;
    }
    if (touched) {
      this.byCwd = next;
      this.persist();
    }
  }

  // Drops agents in the given cwd whose names are not mentioned by any of the
  // provided comment texts. Called by the comments flow after a save so the
  // registry stays in sync with what is actually referenced.
  pruneUnreferenced(cwd: string, mentionedNames: string[]): void {
    const list = this.byCwd[cwd];
    if (!list || list.length === 0) return;
    const keep = new Set(mentionedNames.map((n) => n.toLowerCase()));
    const filtered = list.filter((a) => keep.has(a.name.toLowerCase()));
    if (filtered.length === list.length) return;
    this.byCwd = { ...this.byCwd, [cwd]: filtered };
    this.persist();
  }

  // Generates a name not yet taken in the cwd. If `base` is free, returns it
  // as-is; otherwise appends -2, -3, … until one is free.
  uniqueName(cwd: string, base: string): string {
    const taken = new Set(this.forCwd(cwd).map((a) => a.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.byCwd));
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
