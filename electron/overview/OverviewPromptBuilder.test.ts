import { describe, expect, it } from 'vitest';
import type { SessionTranscript, WorktreeFacts } from '@shared/types/overview.js';
import {
  buildOverviewPrompt,
  OVERVIEW_SYSTEM_PROMPT
} from './OverviewPromptBuilder.js';

const emptyFacts: WorktreeFacts = {
  cwd: '/tmp/wt',
  branch: 'main',
  head: 'abc1234',
  baseBranch: 'main',
  baseOid: 'abc1234',
  commitsAhead: 0,
  commitsBehind: 0,
  commitsAheadShas: [],
  pushedAhead: false,
  mergedIntoBase: false,
  dirtyFiles: [],
  dirtyHash: '',
  evidenceFingerprint: 'evidence',
  completeness: 'complete',
  diagnostics: [],
  workingDiff: '',
  recentCommits: []
};

function makeTranscript(overrides: Partial<SessionTranscript>): SessionTranscript {
  return {
    provider: 'claude_code',
    sessionFile: '/tmp/.claude/projects/foo/123.jsonl',
    sessionId: '123',
    cwd: '/tmp/wt',
    turnCount: 1,
    turns: [{ role: 'user', text: 'hello' }],
    hasCompaction: false,
    watermark: { mtimeMs: 0, size: 0, lastRecordKey: '123' },
    ...overrides
  };
}

describe('OverviewPromptBuilder', () => {
  it('system prompt frames the output as per-session, organized around the tabs', () => {
    expect(OVERVIEW_SYSTEM_PROMPT).toContain('## Sessions');
    expect(OVERVIEW_SYSTEM_PROMPT).toContain('## Worktree state');
    expect(OVERVIEW_SYSTEM_PROMPT).toContain('Most recent');
    expect(OVERVIEW_SYSTEM_PROMPT).toContain('Earlier in this session');
    expect(OVERVIEW_SYSTEM_PROMPT).toContain('tab name');
  });

  it('uses the displayName as the session heading in the context, falling back to the filename', () => {
    const named = makeTranscript({ displayName: 'auth refactor' });
    const unnamed = makeTranscript({
      sessionId: '456',
      sessionFile: '/tmp/.claude/projects/foo/456.jsonl'
    });
    const out = buildOverviewPrompt({
      worktreeCwd: '/tmp/wt',
      facts: emptyFacts,
      transcripts: [named, unnamed]
    });
    expect(out.contextText).toContain('## Session: auth refactor');
    expect(out.contextText).toContain('- tab_name: auth refactor');
    expect(out.contextText).toContain('## Session: 456.jsonl');
  });

  it('lists the open tab names in the instruction so the model uses them verbatim', () => {
    const out = buildOverviewPrompt({
      worktreeCwd: '/tmp/wt',
      facts: emptyFacts,
      transcripts: [
        makeTranscript({ displayName: 'auth refactor' }),
        makeTranscript({
          provider: 'codex',
          sessionId: '789',
          sessionFile: '/tmp/.codex/sessions/789.jsonl',
          displayName: 'docs polish'
        })
      ]
    });
    expect(out.instruction).toContain('auth refactor, docs polish');
    expect(out.instruction).toContain('Use these exact tab names');
  });

  it('tells the model to skip ## Sessions when there are no open tabs', () => {
    const out = buildOverviewPrompt({
      worktreeCwd: '/tmp/wt',
      facts: emptyFacts,
      transcripts: []
    });
    expect(out.instruction).toContain('skip the `## Sessions` section');
  });
});
