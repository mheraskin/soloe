import type { DiffComment } from '../stores/diff-comments.svelte';
import { diffComments } from '../stores/diff-comments.svelte';
import {
  commentAgents,
  parseMentions,
  type CommentAgent
} from '../stores/comment-agents.svelte';
import { sessions } from '../stores/sessions.svelte';
import { sendBracketedPaste } from './terminal-paste';

function rangeLabel(comment: DiffComment): string {
  return comment.endLine === comment.startLine
    ? `L${comment.startLine}`
    : `L${comment.startLine}–${comment.endLine}`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// Renders the "Review scope" preamble for a comment authored under a range
// review. Returns null for working-tree comments or comments whose range info
// is missing — older records persisted before this work.
function scopePreamble(comment: DiffComment): string | null {
  const range = comment.reviewRange;
  if (!range || range.commits.length === 0) return null;
  const noun = range.commits.length === 1 ? 'commit' : 'commits';
  const list = range.commits.map(shortSha).join(' ');
  return `Review scope: ${range.commits.length} ${noun} between ${shortSha(range.base)} and ${shortSha(range.head)}.\nCommits in scope: ${list}.`;
}

function attributionLine(comment: DiffComment): string | null {
  const attr = comment.attributedCommits;
  if (!attr || attr.length === 0) return null;
  const pairs = attr.map((c) => `${c.short}:${c.subject}`).join(', ');
  return `Originated in: ${pairs}`;
}

// Default framing prepended to every send. Without it agents tend to implement
// questions ("why is this here?") instead of answering them.
const INTERPRETATION_GUIDANCE =
  'For each comment, infer intent before acting: answer questions in chat without editing code; implement change requests directly.';

function resolveFooter(ids: string[]): string {
  if (ids.length === 1) {
    return `After addressing this, ask the user "Should I run the soloe MCP tool comment_resolve to mark this resolved?" Only call the tool with id="${ids[0]}" after the user approves.`;
  }
  const list = ids.map((id) => `"${id}"`).join(', ');
  return `After addressing these, ask the user "Should I run the soloe MCP tool comment_resolve_batch to mark these resolved?" Only call the tool with ids=[${list}] after the user approves.`;
}

// Build the prompt body delivered to the target. The leading [soloe-comment:<id>]
// tag is the deterministic handle the agent passes back to the comment_resolve
// MCP tool — keep it on its own line at the very top so simple summarizers
// don't drop it. The trailing instruction gates resolution on user approval so
// the human stays in control of which comments flip to done, while still
// pre-naming the tool and ids so an approval can convert straight into a
// single tool call.
function buildPrompt(comment: DiffComment): string {
  const header = `Re: ${comment.filePath} (${comment.side === 'old' ? 'before' : 'after'} ${rangeLabel(comment)})`;
  const scope = scopePreamble(comment);
  const attribution = attributionLine(comment);
  const body = attribution ? `${comment.text}\n\n${attribution}` : comment.text;
  const parts: string[] = [`[soloe-comment:${comment.id}]`, INTERPRETATION_GUIDANCE];
  if (scope) parts.push(scope);
  parts.push(header, body, resolveFooter([comment.id]));
  return parts.join('\n\n');
}

// Bundle multiple comments into a single delivery. One intro + one footer
// keeps the agent from re-reading the same "call comment_resolve" instruction
// N times, and stops the bracketed paste from triggering N submit-press
// roundtrips in the CLI. The per-comment header still carries the soloe id so
// resolution stays deterministic. An optional preamble is prepended verbatim
// — used by the bulk-send composer so reviewers can frame the batch ("focus
// on perf", "these are nits, ship anyway") without editing each comment. The
// preamble lands after the default guidance so reviewer intent wins on
// recency.
function buildBatchPrompt(comments: DiffComment[], preamble?: string): string {
  if (comments.length === 1 && !preamble) return buildPrompt(comments[0]!);
  const sections = comments.map((c) => {
    const sideLabel = c.side === 'old' ? 'before' : 'after';
    const header = `[soloe-comment:${c.id}] ${c.filePath} (${sideLabel} ${rangeLabel(c)})`;
    const attribution = attributionLine(c);
    return attribution ? `${header}\n${c.text}\n${attribution}` : `${header}\n${c.text}`;
  });
  // A batch typically comes from a single review session, so all comments
  // share the same range — render that scope once. The first range we hit
  // wins; outliers from cross-mode multi-select would still be carried via
  // their per-comment "Originated in:" lines.
  const scope = comments.map(scopePreamble).find((p): p is string => p !== null) ?? null;
  const noun = comments.length === 1 ? 'review comment' : 'review comments';
  const intro = `${comments.length} ${noun} to address:`;
  const parts = [INTERPRETATION_GUIDANCE];
  if (scope) parts.push(scope);
  if (preamble) parts.push(preamble);
  parts.push(intro);
  parts.push(sections.join('\n\n'));
  parts.push(resolveFooter(comments.map((c) => c.id)));
  return parts.join('\n\n');
}

export interface SendCommentResult {
  delivered: number;
  errors: string[];
}

// Resolves a comment's mentions to live target sessions, spawning new ones
// where the agent doesn't have a bound session yet. Updates the registry as
// it goes so subsequent sends to the same agent reuse the spawned session.
async function resolveTargets(comment: DiffComment): Promise<{ targets: { agent: CommentAgent; sessionId: string }[]; errors: string[] }> {
  const out: { agent: CommentAgent; sessionId: string }[] = [];
  const errors: string[] = [];
  const names = parseMentions(comment.text);

  for (const name of names) {
    const agent = commentAgents.byName(comment.cwd, name);
    if (!agent) continue; // unresolved mentions stay as plain text

    let sessionId = agent.spawnedSessionId ?? null;
    // If the agent thinks it's bound to a session that no longer exists, fall
    // through and spawn a fresh one.
    if (sessionId && !sessions.sessions.some((s) => s.id === sessionId)) {
      sessionId = null;
    }

    if (!sessionId) {
      try {
        const created = await sessions.createAgentWithDefaults(agent.provider, {
          cwd: comment.cwd,
          ...(agent.model ? {} : {})
        });
        sessionId = created.id;
        commentAgents.update(agent.id, { spawnedSessionId: sessionId });
      } catch (err) {
        errors.push(`Failed to spawn agent @${agent.name}: ${(err as Error).message}`);
        continue;
      }
    }

    out.push({ agent: { ...agent, spawnedSessionId: sessionId }, sessionId });
  }

  return { targets: out, errors };
}

async function waitForTerminalId(sessionId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tid = sessions.terminalIdFor(sessionId);
    if (tid) return tid;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return sessions.terminalIdFor(sessionId);
}

async function deliverToSession(sessionId: string, payload: string): Promise<void> {
  const terminalId = await waitForTerminalId(sessionId, 5000);
  if (!terminalId) throw new Error('terminal not ready');
  await sendBracketedPaste(terminalId, payload, true);
}

// Sends a comment. With mentions, fans out to each resolved agent's session,
// spawning where needed. Without mentions, drops the prompt into the user's
// currently-selected terminal (the "add as context" flow that mirrors notes).
export async function sendComment(commentId: string): Promise<SendCommentResult> {
  const comment = diffComments.byId(commentId);
  if (!comment) return { delivered: 0, errors: ['Comment not found'] };
  if (!comment.text.trim()) return { delivered: 0, errors: ['Comment is empty'] };

  const payload = buildPrompt(comment);
  const errors: string[] = [];
  let delivered = 0;

  const mentions = parseMentions(comment.text);
  const hasResolvedMention = mentions.some((n) => commentAgents.byName(comment.cwd, n));

  if (hasResolvedMention) {
    const { targets, errors: resolveErrors } = await resolveTargets(comment);
    errors.push(...resolveErrors);
    for (const { agent, sessionId } of targets) {
      try {
        await deliverToSession(sessionId, payload);
        delivered += 1;
      } catch (err) {
        errors.push(`Send to @${agent.name} failed: ${(err as Error).message}`);
      }
    }
  } else {
    const selected = sessions.selected;
    if (!selected) {
      errors.push('No active session to receive the comment');
    } else {
      const terminalId = sessions.terminalIdFor(selected.id);
      if (!terminalId) {
        errors.push(`Session ${selected.name} has no running terminal`);
      } else {
        try {
          await sendBracketedPaste(terminalId, payload, true);
          delivered += 1;
        } catch (err) {
          errors.push((err as Error).message);
        }
      }
    }
  }

  if (delivered > 0) {
    diffComments.update(comment.id, { sentAt: Date.now() });
  }

  return { delivered, errors };
}

// Resolve the set of target sessions a single comment routes to. With
// mentions, each resolved agent's session counts. Without mentions, falls
// back to the currently-selected session (mirrors the "add as context" flow).
async function resolveSessionTargets(
  comment: DiffComment
): Promise<{ sessionIds: string[]; errors: string[] }> {
  const errors: string[] = [];
  const sessionIds = new Set<string>();
  const mentions = parseMentions(comment.text);
  const hasResolvedMention = mentions.some((n) => commentAgents.byName(comment.cwd, n));

  if (hasResolvedMention) {
    const { targets, errors: resolveErrors } = await resolveTargets(comment);
    errors.push(...resolveErrors);
    for (const { sessionId } of targets) sessionIds.add(sessionId);
  } else {
    const selected = sessions.selected;
    if (!selected) {
      errors.push('No active session to receive the comment');
    } else {
      sessionIds.add(selected.id);
    }
  }

  return { sessionIds: [...sessionIds], errors };
}

// Send a set of comments. Each session that receives any comment gets exactly
// one bracketed-paste containing every comment routed to it, so the underlying
// CLI sees one user message instead of N. A comment that fans out to several
// sessions is still counted once in `delivered` (it lands in each session's
// bundle) and is flagged sent once any session accepted it.
export async function sendComments(
  commentIds: string[],
  preamble?: string
): Promise<SendCommentResult> {
  const cleanPreamble = preamble?.trim() ? preamble.trim() : undefined;
  // Single-comment fast path only applies without a preamble — otherwise we
  // need the batch builder to slot the preamble above the comment.
  if (commentIds.length === 1 && !cleanPreamble) {
    return sendComment(commentIds[0]!);
  }

  const errors: string[] = [];
  // sessionId -> ordered comments to bundle for that target.
  const bySession = new Map<string, DiffComment[]>();

  for (const id of commentIds) {
    const comment = diffComments.byId(id);
    if (!comment) {
      errors.push('Comment not found');
      continue;
    }
    if (!comment.text.trim()) {
      errors.push('Comment is empty');
      continue;
    }
    const { sessionIds, errors: resolveErrors } = await resolveSessionTargets(comment);
    errors.push(...resolveErrors);
    for (const sid of sessionIds) {
      const list = bySession.get(sid) ?? [];
      list.push(comment);
      bySession.set(sid, list);
    }
  }

  const deliveredIds = new Set<string>();
  for (const [sessionId, comments] of bySession) {
    const payload = buildBatchPrompt(comments, cleanPreamble);
    try {
      await deliverToSession(sessionId, payload);
      for (const c of comments) deliveredIds.add(c.id);
    } catch (err) {
      errors.push(`Send to session failed: ${(err as Error).message}`);
    }
  }

  const now = Date.now();
  for (const id of deliveredIds) {
    diffComments.update(id, { sentAt: now });
  }

  return { delivered: deliveredIds.size, errors };
}
