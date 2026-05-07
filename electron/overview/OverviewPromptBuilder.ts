import * as path from 'node:path';
import type {
  ChatMessage,
  OverviewSourcesSummary,
  SessionTranscript,
  WorktreeFacts
} from '@shared/types/overview.js';

const APPROX_CHARS_PER_TOKEN = 4;
const MAX_TURN_CHARS = 4_000;

export const OVERVIEW_SYSTEM_PROMPT = [
  'You are summarizing the agent activity that happened inside a single git worktree of a software project.',
  'You will receive: (a) the full transcripts of every Claude Code and Codex session that ran in that worktree, (b) the current git facts (branch, ahead/behind, dirty files, merged status), and (c) the working diff vs HEAD.',
  '',
  'Produce a concise, structured overview that answers, in order:',
  '1. **What was worked on** — group by feature/topic across sessions, not by session. Mention which agent (Claude Code or Codex) tackled each chunk if useful.',
  '2. **Shipped** — commits that are on the current branch and pushed to a remote.',
  '3. **Committed but not pushed** — commits ahead of upstream/base, still local.',
  '4. **Merged into base** — commits already integrated into the base branch.',
  '5. **Uncommitted changes** — staged, unstaged, untracked files; what they appear to be doing based on the diff.',
  '6. **Open threads** — anything an agent was mid-way through, blocked on, or asking the user about.',
  '',
  'Rules:',
  '- Use markdown headings exactly as above.',
  '- Be specific: name files, features, decisions. Skip filler.',
  '- If the working diff contradicts what an agent claimed it shipped, flag it.',
  '- If sessions were compacted, treat pre-compaction history as equally real.',
  '- Do not invent details. If something is uncertain, say so briefly.'
].join('\n');

export const FOLLOWUP_SYSTEM_PROMPT = [
  OVERVIEW_SYSTEM_PROMPT,
  '',
  'You have already produced an overview. The user is now asking follow-up questions about the same worktree, with the same source material in context. Answer concisely and refer back to specific transcripts, commits, files, or diff hunks when useful.'
].join('\n');

export interface BuildOverviewPromptInput {
  worktreeCwd: string;
  facts: WorktreeFacts;
  transcripts: SessionTranscript[];
}

export interface BuiltPrompt {
  systemPrompt: string;
  contextText: string;
  instruction: string;
  approxInputTokens: number;
  sources: OverviewSourcesSummary;
}

export function buildOverviewPrompt(input: BuildOverviewPromptInput): BuiltPrompt {
  const contextText = renderContext(input);
  const instruction = `Produce the overview for worktree ${input.worktreeCwd} now, following the structure in the system prompt.`;
  const sources: OverviewSourcesSummary = {
    sessionCount: input.transcripts.length,
    totalTurns: input.transcripts.reduce((acc, t) => acc + t.turnCount, 0),
    providers: dedupeProviders(input.transcripts.map((t) => t.provider)),
    approxInputTokens: 0
  };
  const totalChars = OVERVIEW_SYSTEM_PROMPT.length + contextText.length + instruction.length;
  sources.approxInputTokens = Math.ceil(totalChars / APPROX_CHARS_PER_TOKEN);
  return {
    systemPrompt: OVERVIEW_SYSTEM_PROMPT,
    contextText,
    instruction,
    approxInputTokens: sources.approxInputTokens,
    sources
  };
}

export interface BuildFollowUpPromptInput extends BuildOverviewPromptInput {
  history: ChatMessage[];
  message: string;
  cachedOverview?: string | null;
}

export function buildFollowUpPrompt(input: BuildFollowUpPromptInput): {
  systemPrompt: string;
  contextText: string;
  conversation: ChatMessage[];
  approxInputTokens: number;
} {
  const baseContext = renderContext(input);
  const contextText = input.cachedOverview
    ? `${baseContext}\n\n# Previously generated overview\n${input.cachedOverview}`
    : baseContext;
  const conversation: ChatMessage[] = [
    ...input.history,
    { role: 'user', content: input.message }
  ];
  const totalChars =
    FOLLOWUP_SYSTEM_PROMPT.length +
    contextText.length +
    conversation.reduce((acc, m) => acc + m.content.length, 0);
  return {
    systemPrompt: FOLLOWUP_SYSTEM_PROMPT,
    contextText,
    conversation,
    approxInputTokens: Math.ceil(totalChars / APPROX_CHARS_PER_TOKEN)
  };
}

function renderContext(input: BuildOverviewPromptInput): string {
  const parts: string[] = [];
  parts.push(`# Worktree\n${input.worktreeCwd}`);
  parts.push(renderFacts(input.facts));
  parts.push(renderWorkingDiff(input.facts));
  parts.push(renderTranscripts(input.transcripts));
  return parts.join('\n\n');
}

function renderFacts(facts: WorktreeFacts): string {
  const lines: string[] = ['# Git facts'];
  lines.push(`- branch: ${facts.branch ?? '(detached)'}`);
  lines.push(`- HEAD: ${facts.head ?? '(unknown)'}`);
  lines.push(`- base: ${facts.baseBranch ?? '(none detected)'}`);
  lines.push(`- ahead/behind base: ${facts.commitsAhead}/${facts.commitsBehind}`);
  lines.push(`- pushed (any remote contains tip of ahead): ${facts.pushedAhead ? 'yes' : 'no'}`);
  lines.push(`- merged into base: ${facts.mergedIntoBase ? 'yes' : 'no'}`);
  if (facts.dirtyFiles.length > 0) {
    lines.push('- dirty files:');
    for (const f of facts.dirtyFiles.slice(0, 200)) {
      lines.push(`  - [${f.status}/${f.kind}] ${f.path}`);
    }
    if (facts.dirtyFiles.length > 200) {
      lines.push(`  - …and ${facts.dirtyFiles.length - 200} more`);
    }
  } else {
    lines.push('- dirty files: (none)');
  }
  if (facts.recentCommits.length > 0) {
    lines.push('- recent commits (newest first):');
    for (const c of facts.recentCommits) {
      const flags = [
        c.mergedIntoBase ? 'merged' : null,
        c.pushed ? 'pushed' : 'local'
      ]
        .filter(Boolean)
        .join(',');
      lines.push(`  - ${c.shortSha} [${flags}] ${c.subject}`);
    }
  }
  return lines.join('\n');
}

function renderWorkingDiff(facts: WorktreeFacts): string {
  if (!facts.workingDiff || facts.workingDiff.trim().length === 0) {
    return '# Working diff vs HEAD\n(empty)';
  }
  return `# Working diff vs HEAD\n\`\`\`diff\n${facts.workingDiff}\n\`\`\``;
}

function renderTranscripts(transcripts: SessionTranscript[]): string {
  if (transcripts.length === 0) return '# Sessions\n(no Claude or Codex sessions found in this worktree)';
  const blocks: string[] = ['# Sessions'];
  for (const t of transcripts) {
    blocks.push(renderTranscript(t));
  }
  return blocks.join('\n\n');
}

function renderTranscript(t: SessionTranscript): string {
  const header = [
    `## Session: ${path.basename(t.sessionFile)}`,
    `- provider: ${t.provider}`,
    `- session_id: ${t.sessionId}`,
    t.startedAt ? `- started: ${t.startedAt}` : null,
    t.endedAt ? `- ended: ${t.endedAt}` : null,
    `- turns: ${t.turnCount}`,
    t.hasCompaction ? '- compaction: yes (pre-compaction history is included)' : null
  ]
    .filter(Boolean)
    .join('\n');
  const body = t.turns
    .map((turn) => renderTurn(turn))
    .join('\n\n');
  return `${header}\n\n${body}`;
}

function renderTurn(turn: SessionTranscript['turns'][number]): string {
  const text = turn.text.length > MAX_TURN_CHARS
    ? turn.text.slice(0, MAX_TURN_CHARS) + `\n…[turn truncated, ${turn.text.length - MAX_TURN_CHARS} chars elided]`
    : turn.text;
  if (turn.role === 'tool') {
    return `### tool · ${turn.toolName ?? 'tool'}\n${text}`;
  }
  if (turn.role === 'system') {
    return `### system\n${text}`;
  }
  return `### ${turn.role}\n${text}`;
}

function dedupeProviders(arr: SessionTranscript['provider'][]): SessionTranscript['provider'][] {
  return [...new Set(arr)];
}
