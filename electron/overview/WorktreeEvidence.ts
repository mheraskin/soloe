import type {
  OverviewSessionInput,
  OverviewWatermark,
  WorktreeFacts,
  WorktreeSessionRef
} from '@shared/types/overview.js';
import type { RunMode } from '@shared/types/sessions.js';
import { worktreeIdentityKey } from '@shared/worktree-identity.js';
import type { SessionTranscriptReader } from './SessionTranscriptReader.js';
import type { WorktreeFactsCollector } from './WorktreeFactsCollector.js';

export interface WorktreeEvidenceInput {
  worktreeCwd: string;
  runMode?: RunMode;
  wslDistro?: string;
  baseBranch?: string;
  sessions?: OverviewSessionInput[];
}

export interface WorktreeEvidenceGeneration {
  key: string;
  refs: WorktreeSessionRef[];
  facts: WorktreeFacts;
  watermark: OverviewWatermark;
}

export interface WorktreeEvidenceOptions {
  reader: Pick<SessionTranscriptReader, 'listScopedSessions' | 'listAllSessions'>;
  facts: Pick<WorktreeFactsCollector, 'collect'>;
  reuseMs?: number;
  maxRetained?: number;
}

const DEFAULT_REUSE_MS = 5_000;
const DEFAULT_MAX_RETAINED = 8;

/**
 * Materializes one immutable evidence generation and owns short-lived handoff
 * from cache validation to regeneration. Acquisition is coalesced by identity.
 */
export class WorktreeEvidence {
  private readonly inFlight = new Map<string, Promise<WorktreeEvidenceGeneration>>();
  private readonly retained = new Map<
    string,
    { evidence: WorktreeEvidenceGeneration; expiresAt: number }
  >();
  private readonly reuseMs: number;
  private readonly maxRetained: number;

  constructor(private readonly options: WorktreeEvidenceOptions) {
    this.reuseMs = Math.max(0, Math.trunc(options.reuseMs ?? DEFAULT_REUSE_MS));
    this.maxRetained = positiveInteger(options.maxRetained, DEFAULT_MAX_RETAINED);
  }

  /** Inspect and retain a generation for one immediate regeneration handoff. */
  async inspect(input: WorktreeEvidenceInput): Promise<WorktreeEvidenceGeneration> {
    const evidence = await this.materialize(input);
    this.retained.delete(evidence.key);
    this.retained.set(evidence.key, {
      evidence,
      expiresAt: Date.now() + this.reuseMs
    });
    this.pruneRetained();
    return evidence;
  }

  /** Consume the inspected generation once, or materialize a fresh one. */
  consume(input: WorktreeEvidenceInput): Promise<WorktreeEvidenceGeneration> {
    const key = worktreeEvidenceKey(input);
    const retained = this.retained.get(key);
    this.retained.delete(key);
    if (retained && retained.expiresAt >= Date.now()) {
      return Promise.resolve(retained.evidence);
    }
    return this.materialize(input);
  }

  materialize(input: WorktreeEvidenceInput): Promise<WorktreeEvidenceGeneration> {
    const key = worktreeEvidenceKey(input);
    const current = this.inFlight.get(key);
    if (current) return current;
    const scope = { runMode: input.runMode, wslDistro: input.wslDistro };
    const refsPromise = input.sessions
      ? this.options.reader.listScopedSessions(input.sessions, input.worktreeCwd, scope)
      : this.options.reader.listAllSessions(input.worktreeCwd, scope);
    const request = Promise.all([
      refsPromise,
      this.options.facts.collect(input.worktreeCwd, input.baseBranch, scope)
    ]).then(([refs, facts]) => ({
      key,
      refs,
      facts,
      watermark: {
        perSession: refs.map((ref) => ({
          sessionFile: ref.sessionFile,
          ...(ref.displayName !== undefined ? { displayName: ref.displayName } : {}),
          mtimeMs: ref.watermark.mtimeMs,
          size: ref.watermark.size,
          lastRecordKey: ref.watermark.lastRecordKey
        })),
        scopeKey: key,
        evidenceFingerprint: facts.evidenceFingerprint,
        headSha: facts.head,
        dirtyHash: facts.dirtyHash
      }
    })).finally(() => {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  private pruneRetained(): void {
    const now = Date.now();
    for (const [key, entry] of this.retained) {
      if (entry.expiresAt < now) this.retained.delete(key);
    }
    while (this.retained.size > this.maxRetained) {
      const oldest = this.retained.keys().next().value as string | undefined;
      if (!oldest) return;
      this.retained.delete(oldest);
    }
  }
}

export function worktreeEvidenceKey(input: WorktreeEvidenceInput): string {
  return JSON.stringify({
    worktree: worktreeIdentityKey(input.worktreeCwd, {
      ...(input.runMode ? { runMode: input.runMode } : {}),
      ...(input.wslDistro ? { wslDistro: input.wslDistro } : {})
    }),
    baseBranch: input.baseBranch?.trim() ?? '',
    sessions: input.sessions?.map((session) => [session.transcriptPath, session.name]) ?? null
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const resolved = Math.trunc(value ?? fallback);
  return resolved > 0 ? resolved : fallback;
}
