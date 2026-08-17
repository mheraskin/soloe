import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/types/settings.js';
import { CLI_DEFAULT_MODEL_ID } from '@shared/model-catalog.js';
import type { WorktreeFacts } from '@shared/types/overview.js';
import type { BackgroundAgentExecution } from '../agents/BackgroundAgentExecution.js';
import { WorktreeOverviewService } from './WorktreeOverviewService.js';
import type { SessionTranscriptReader } from './SessionTranscriptReader.js';
import type { WorktreeFactsCollector } from './WorktreeFactsCollector.js';
import type { SummaryCacheStore } from './SummaryCacheStore.js';

const facts: WorktreeFacts = {
  cwd: '/repo',
  branch: 'main',
  head: 'a'.repeat(40),
  baseBranch: 'main',
  baseOid: 'a'.repeat(40),
  commitsAhead: 0,
  commitsBehind: 0,
  commitsAheadShas: [],
  pushedAhead: false,
  mergedIntoBase: true,
  dirtyFiles: [],
  dirtyHash: 'clean',
  evidenceFingerprint: 'evidence',
  completeness: 'complete',
  diagnostics: [],
  workingDiff: '',
  recentCommits: []
};

describe('WorktreeOverviewService background execution', () => {
  it('records the fallback provider selected by the shared execution Module', async () => {
    const set = vi.fn(async () => undefined);
    const execute = vi.fn(async () => ({
      ok: true as const,
      text: 'overview text',
      provider: { provider: 'claude' as const, id: 'sonnet' }
    }));
    const service = new WorktreeOverviewService({
      reader: {
        listScopedSessions: vi.fn(async () => []),
        listAllSessions: vi.fn(async () => []),
        readTranscript: vi.fn()
      } as unknown as SessionTranscriptReader,
      facts: { collect: vi.fn(async () => facts) } as unknown as WorktreeFactsCollector,
      cache: { get: vi.fn(async () => null), set } as unknown as SummaryCacheStore,
      getSettings: () => ({
        ...DEFAULT_SETTINGS,
        integrations: { ...DEFAULT_SETTINGS.integrations, allowClaudeHeadless: true }
      }),
      execution: { execute } as unknown as BackgroundAgentExecution
    });

    const overview = await service.regenerate({
      worktreeCwd: '/repo',
      runMode: 'windows',
      sessions: []
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      priority: 'interactive',
      candidates: [
        { provider: 'codex', id: CLI_DEFAULT_MODEL_ID },
        { provider: 'claude', id: CLI_DEFAULT_MODEL_ID },
        { provider: 'cursor', id: CLI_DEFAULT_MODEL_ID }
      ]
    }));
    expect(overview).toMatchObject({
      status: 'fresh',
      text: 'overview text',
      generatedBy: { provider: 'claude_code', model: 'sonnet' }
    });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('reuses the evidence generation validated immediately before regeneration', async () => {
    const collect = vi.fn(async () => facts);
    const execute = vi.fn(async () => ({
      ok: true as const,
      text: 'overview text',
      provider: { provider: 'codex' as const, id: 'gpt-5.4-mini' }
    }));
    const service = new WorktreeOverviewService({
      reader: {
        listScopedSessions: vi.fn(async () => []),
        listAllSessions: vi.fn(async () => []),
        readTranscript: vi.fn()
      } as unknown as SessionTranscriptReader,
      facts: { collect } as unknown as WorktreeFactsCollector,
      cache: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined)
      } as unknown as SummaryCacheStore,
      getSettings: () => DEFAULT_SETTINGS,
      execution: { execute } as unknown as BackgroundAgentExecution
    });
    const args = { worktreeCwd: '/repo', runMode: 'windows' as const, sessions: [] };

    const initial = await service.getOverview(args);
    expect(initial.status).toBe('missing');
    await service.regenerate(args);

    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('does not generate or cache an overview from degraded evidence', async () => {
    const execute = vi.fn();
    const set = vi.fn();
    const service = new WorktreeOverviewService({
      reader: {
        listScopedSessions: vi.fn(async () => []),
        listAllSessions: vi.fn(async () => []),
        readTranscript: vi.fn()
      } as unknown as SessionTranscriptReader,
      facts: {
        collect: vi.fn(async () => ({
          ...facts,
          completeness: 'degraded' as const,
          diagnostics: ['read worktree status: git exited with code 128']
        }))
      } as unknown as WorktreeFactsCollector,
      cache: { get: vi.fn(async () => null), set } as unknown as SummaryCacheStore,
      getSettings: () => DEFAULT_SETTINGS,
      execution: { execute } as unknown as BackgroundAgentExecution
    });

    const overview = await service.regenerate({ worktreeCwd: '/repo', sessions: [] });

    expect(overview).toMatchObject({
      status: 'missing',
      errorMessage: expect.stringContaining('read worktree status')
    });
    expect(execute).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
