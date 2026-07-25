import { spawn } from 'node:child_process';
import type {
  ChatMessage,
  OverviewProvider,
  OverviewSessionInput,
  WorktreeOverview
} from '@shared/types/overview.js';
import type { ModelProvider, ModelSelection, Settings } from '@shared/types/settings.js';
import type { RunMode } from '@shared/types/sessions.js';
import { nativeRunMode } from '@shared/platform.js';
import { BackgroundAgentExecution } from '../agents/BackgroundAgentExecution.js';
import { SessionTranscriptReader } from './SessionTranscriptReader.js';
import { WorktreeFactsCollector } from './WorktreeFactsCollector.js';
import {
  buildFollowUpPrompt,
  buildOverviewPrompt
} from './OverviewPromptBuilder.js';
import {
  SummaryCacheStore,
  watermarksMatch,
  type CachedOverviewEntry
} from './SummaryCacheStore.js';
import {
  WorktreeEvidence,
  worktreeEvidenceKey
} from './WorktreeEvidence.js';

const OVERVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const FOLLOWUP_TIMEOUT_MS = 5 * 60 * 1000;

export interface WorktreeOverviewServiceOptions {
  reader: SessionTranscriptReader;
  facts: WorktreeFactsCollector;
  cache: SummaryCacheStore;
  getSettings: () => Promise<Settings> | Settings;
  spawnImpl?: typeof spawn;
  execution?: BackgroundAgentExecution;
  evidence?: WorktreeEvidence;
  log?: (msg: string, detail?: unknown) => void;
}

export interface GenerateOverviewArgs {
  worktreeCwd: string;
  runMode?: RunMode;
  wslDistro?: string;
  baseBranch?: string;
  // When present, scope the overview to just these transcripts (the
  // sessions the renderer has open in this worktree) instead of every
  // historical .jsonl found under .claude/projects + .codex/sessions for
  // this cwd. Each entry carries the user-visible tab name so the
  // generated overview can be organized around how the user sees the
  // sessions, not the on-disk filename.
  sessions?: OverviewSessionInput[];
}

export interface StreamFollowUpArgs extends GenerateOverviewArgs {
  message: string;
  history: ChatMessage[];
}

export interface FollowUpChunk {
  type: 'delta' | 'done' | 'error';
  text?: string;
  error?: string;
}

export class WorktreeOverviewService {
  // Dedup concurrent regenerate calls for the same worktree so that closing
  // and reopening the dialog (or two dialogs on the same cwd) wait on the
  // same spawn rather than firing a duplicate. Cache writes happen before
  // the promise resolves, so subsequent getOverview calls hit the cache.
  private readonly inFlightRegens = new Map<string, Promise<WorktreeOverview>>();
  private readonly execution: BackgroundAgentExecution;
  private readonly evidence: WorktreeEvidence;

  constructor(private readonly opts: WorktreeOverviewServiceOptions) {
    this.execution = opts.execution ?? new BackgroundAgentExecution({
      ...(opts.spawnImpl ? {
        spawnImpl: opts.spawnImpl,
        isExecutableAvailable: async () => true
      } : {})
    });
    this.evidence = opts.evidence ?? new WorktreeEvidence({
      reader: opts.reader,
      facts: opts.facts
    });
  }

  async getOverview(args: GenerateOverviewArgs): Promise<WorktreeOverview> {
    const cwd = args.worktreeCwd;
    const { refs, facts, watermark } = await this.evidence.inspect(args);
    const cached = await this.opts.cache.get(cwd, args);
    if (facts.completeness === 'complete' && cached && watermarksMatch(cached.watermark, watermark)) {
      return {
        worktreeCwd: cwd,
        status: 'cached',
        text: cached.text,
        generatedAt: cached.generatedAt,
        generatedBy: cached.generatedBy,
        watermark: cached.watermark,
        sources: cached.sources,
        facts
      };
    }
    return {
      worktreeCwd: cwd,
      status: cached ? 'stale' : 'missing',
      text: cached?.text ?? null,
      generatedAt: cached?.generatedAt ?? null,
      generatedBy: cached?.generatedBy ?? null,
      watermark: cached?.watermark ?? null,
      sources: cached?.sources ?? {
        sessionCount: refs.length,
        totalTurns: 0,
        providers: dedupeProviders(refs.map((r) => r.provider)),
        approxInputTokens: 0
      },
      facts,
      ...(facts.completeness === 'degraded'
        ? { errorMessage: incompleteEvidenceMessage(facts) }
        : {})
    };
  }

  async regenerate(args: GenerateOverviewArgs): Promise<WorktreeOverview> {
    const cwd = args.worktreeCwd;
    const requestKey = worktreeEvidenceKey(args);
    const existing = this.inFlightRegens.get(requestKey);
    if (existing) {
      console.log('[overview.service] regenerate join in-flight', { cwd });
      return existing;
    }
    const promise = this.runRegenerate(cwd, args).finally(() => {
      this.inFlightRegens.delete(requestKey);
    });
    this.inFlightRegens.set(requestKey, promise);
    return promise;
  }

  private async runRegenerate(cwd: string, args: GenerateOverviewArgs): Promise<WorktreeOverview> {
    console.log('[overview.service] regenerate start', { cwd, runMode: args.runMode, wslDistro: args.wslDistro, baseBranch: args.baseBranch, openSessions: args.sessions?.length ?? null });
    const { refs, facts, watermark } = await this.evidence.consume(args);
    console.log('[overview.service] sources collected', { sessionCount: refs.length, headSha: facts.head, branch: facts.branch });
    if (facts.completeness === 'degraded') {
      return {
        worktreeCwd: cwd,
        status: 'missing',
        text: null,
        generatedAt: null,
        generatedBy: null,
        watermark: null,
        sources: emptySources(refs),
        facts,
        errorMessage: incompleteEvidenceMessage(facts)
      };
    }
    const transcripts = await Promise.all(refs.map((r) => this.opts.reader.readTranscript(r)));
    const built = buildOverviewPrompt({
      worktreeCwd: cwd,
      facts,
      transcripts
    });

    const settings = await this.opts.getSettings();
    const providerPolicy = providerCandidates(settings);
    console.log('[overview.service] provider policy', providerPolicy);
    if (providerPolicy.reason === 'claude_blocked') {
      return {
        worktreeCwd: cwd,
        status: 'missing',
        text: null,
        generatedAt: null,
        generatedBy: null,
        watermark: null,
        sources: built.sources,
        facts,
        errorMessage: CLAUDE_HEADLESS_BLOCKED_MESSAGE
      };
    }

    const fullPrompt = `${built.systemPrompt}\n\n${built.contextText}\n\n${built.instruction}`;
    const result = await this.execution.execute({
      candidates: providerPolicy.candidates,
      binaries: settings.binaries,
      scope: {
        cwd,
        runMode: args.runMode ?? nativeRunMode(),
        ...(args.wslDistro ? { wslDistro: args.wslDistro } : {})
      },
      prompt: fullPrompt,
      timeoutMs: OVERVIEW_TIMEOUT_MS,
      priority: 'interactive'
    });

    if (!result.ok) {
      return {
        worktreeCwd: cwd,
        status: 'missing',
        text: null,
        generatedAt: null,
        generatedBy: null,
        watermark: null,
        sources: built.sources,
        facts,
        errorMessage: result.reason === 'unavailable'
          ? 'No Claude or Codex executable is available. Connect one in Settings → Agent integration.'
          : `Overview generation failed: ${result.error}`
      };
    }

    const entry: CachedOverviewEntry = {
      worktreeCwd: cwd,
      runMode: args.runMode ?? nativeRunMode(),
      ...(args.wslDistro ? { wslDistro: args.wslDistro } : {}),
      text: result.text,
      generatedAt: new Date().toISOString(),
      generatedBy: {
        provider: toAgentProvider(result.provider.provider),
        model: result.provider.id
      },
      watermark,
      sources: built.sources
    };
    await this.opts.cache.set(entry);

    return {
      worktreeCwd: cwd,
      status: 'fresh',
      text: entry.text,
      generatedAt: entry.generatedAt,
      generatedBy: entry.generatedBy,
      watermark,
      sources: built.sources,
      facts
    };
  }

  async *streamFollowUp(
    args: StreamFollowUpArgs,
    signal?: AbortSignal
  ): AsyncIterable<FollowUpChunk> {
    const cwd = args.worktreeCwd;
    const { refs, facts } = await this.evidence.materialize(args);
    if (facts.completeness === 'degraded') {
      yield { type: 'error', error: incompleteEvidenceMessage(facts) };
      return;
    }
    const transcripts = await Promise.all(refs.map((r) => this.opts.reader.readTranscript(r)));
    const cached = await this.opts.cache.get(cwd, args);
    const built = buildFollowUpPrompt({
      worktreeCwd: cwd,
      facts,
      transcripts,
      history: args.history,
      message: args.message,
      cachedOverview: cached?.text
    });

    const settings = await this.opts.getSettings();
    const providerPolicy = providerCandidates(settings);
    if (providerPolicy.reason === 'claude_blocked') {
      yield {
        type: 'error',
        error: CLAUDE_HEADLESS_BLOCKED_MESSAGE
      };
      return;
    }

    const conversationText = built.conversation
      .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
      .join('\n\n');
    const fullPrompt = `${built.systemPrompt}\n\n${built.contextText}\n\n# Conversation\n${conversationText}\n\nASSISTANT:`;

    yield* this.execution.stream({
      candidates: providerPolicy.candidates,
      binaries: settings.binaries,
      scope: {
        cwd,
        runMode: args.runMode ?? nativeRunMode(),
        ...(args.wslDistro ? { wslDistro: args.wslDistro } : {})
      },
      prompt: fullPrompt,
      timeoutMs: FOLLOWUP_TIMEOUT_MS,
      priority: 'interactive',
      ...(signal ? { signal } : {})
    });
  }

}

export const CLAUDE_HEADLESS_BLOCKED_MESSAGE =
  'Claude is disabled for Soloe-dispatched tasks. Enable "Allow Claude for Soloe-dispatched tasks" in Settings → Integration, or pick a Codex model.';

type ProviderPolicy =
  | { candidates: ModelSelection[]; reason?: never }
  | { candidates: []; reason: 'claude_blocked' };

function providerCandidates(settings: Settings): ProviderPolicy {
  // Prefer the dedicated overview slot; fall back to the older textGeneration
  // slot for settings written before worktreeOverview existed.
  const configured = settings.models.worktreeOverview ?? settings.models.textGeneration ?? null;
  const claudeAllowed = settings.integrations.allowClaudeHeadless === true;
  // Honor a saved Claude pick only when the user has opted into headless
  // Claude usage; otherwise the renderer will have surfaced the disabled
  // state and the service refuses rather than billing surprise API calls.
  if (configured) {
    if (configured.provider === 'claude' && !claudeAllowed) {
      return { candidates: [], reason: 'claude_blocked' };
    }
    const candidates = [configured];
    if (configured.provider === 'codex' && claudeAllowed) {
      candidates.push({ provider: 'claude', id: 'sonnet' });
    } else if (configured.provider === 'claude') {
      candidates.push({ provider: 'codex', id: 'gpt-5.4' });
    }
    return { candidates };
  }
  return {
    candidates: claudeAllowed
      ? [
          { provider: 'claude', id: 'sonnet' },
          { provider: 'codex', id: 'gpt-5.4' }
        ]
      : [{ provider: 'codex', id: 'gpt-5.4' }]
  };
}

function dedupeProviders(arr: OverviewProvider[]): OverviewProvider[] {
  return [...new Set(arr)];
}

function incompleteEvidenceMessage(facts: WorktreeOverview['facts']): string {
  const detail = facts.diagnostics.slice(0, 3).join('; ');
  return `Worktree evidence is incomplete${detail ? `: ${detail}` : '.'}`;
}

function emptySources(
  refs: Awaited<ReturnType<SessionTranscriptReader['listAllSessions']>>
): WorktreeOverview['sources'] {
  return {
    sessionCount: refs.length,
    totalTurns: 0,
    providers: dedupeProviders(refs.map((ref) => ref.provider)),
    approxInputTokens: 0
  };
}

function toAgentProvider(p: ModelProvider): OverviewProvider {
  return p === 'claude' ? 'claude_code' : 'codex';
}
