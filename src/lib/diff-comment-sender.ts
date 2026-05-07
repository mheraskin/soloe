import type { DiffComment } from '../stores/diff-comments.svelte';
import { diffComments } from '../stores/diff-comments.svelte';
import {
  commentAgents,
  parseMentions,
  type CommentAgent
} from '../stores/comment-agents.svelte';
import { sessions } from '../stores/sessions.svelte';
import { ipc } from './ipc';

// Send protocol for sessions: bracketed paste so the agent receives the
// payload as a single user prompt instead of being interpreted line-by-line.
// The trailing CR submits it (Claude/Codex both treat 201~ + \r as enter).
function bracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(/\x1b/g, '')}\x1b[201~\r`;
}

// Build the prompt body delivered to the target. The leading [soloe-comment:<id>]
// tag is the deterministic handle the agent passes back to the comment_resolve
// MCP tool — keep it on its own line at the very top so simple summarizers
// don't drop it. The trailing instruction is what actually nudges the agent to
// close the loop; without it, well-behaved agents can still discover the tool
// from tools/list, but resolution becomes opportunistic rather than expected.
function buildPrompt(comment: DiffComment): string {
  const range =
    comment.endLine === comment.startLine
      ? `L${comment.startLine}`
      : `L${comment.startLine}–${comment.endLine}`;
  const header = `Re: ${comment.filePath} (${comment.side === 'old' ? 'before' : 'after'} ${range})`;
  const footer = `When you have addressed this, call the soloe MCP tool comment_resolve with id="${comment.id}".`;
  return `[soloe-comment:${comment.id}]\n${header}\n\n${comment.text}\n\n${footer}`;
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
  await ipc.terminal.input(terminalId, bracketedPaste(payload));
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
          await ipc.terminal.input(terminalId, bracketedPaste(payload));
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

// Send every unsent comment in the worktree's current set, in order. Used by
// the rail's "Send all" affordance. Returns aggregate counts so the caller
// can toast a summary.
export async function sendComments(commentIds: string[]): Promise<SendCommentResult> {
  let delivered = 0;
  const errors: string[] = [];
  for (const id of commentIds) {
    const r = await sendComment(id);
    delivered += r.delivered;
    errors.push(...r.errors);
  }
  return { delivered, errors };
}
