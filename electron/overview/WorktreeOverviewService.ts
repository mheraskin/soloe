import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import type {
  ChatMessage,
  OverviewProvider,
  OverviewWatermark,
  WorktreeOverview
} from '@shared/types/overview.js';
import type { ModelProvider, ModelSelection, Settings, SettingsBinaries } from '@shared/types/settings.js';
import type { RunMode } from '@shared/types/sessions.js';
import { WslCommandBuilder } from '../runtime/WslCommandBuilder.js';
import { buildWslAgentLine } from '../sessions/SessionCommandBuilder.js';
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

const OVERVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const FOLLOWUP_TIMEOUT_MS = 5 * 60 * 1000;

export interface WorktreeOverviewServiceOptions {
  reader: SessionTranscriptReader;
  facts: WorktreeFactsCollector;
  cache: SummaryCacheStore;
  getSettings: () => Promise<Settings> | Settings;
  spawnImpl?: typeof spawn;
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
  // this cwd.
  sessionFiles?: string[];
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

  constructor(private readonly opts: WorktreeOverviewServiceOptions) {}

  async getOverview(args: GenerateOverviewArgs): Promise<WorktreeOverview> {
    const cwd = args.worktreeCwd;
    const scope = { runMode: args.runMode, wslDistro: args.wslDistro };
    const [refs, facts] = await Promise.all([
      this.listScopedOrAll(cwd, scope, args.sessionFiles),
      this.opts.facts.collect(cwd, args.baseBranch, scope)
    ]);
    const watermark: OverviewWatermark = {
      perSession: refs.map((r) => ({
        sessionFile: r.sessionFile,
        lastRecordKey: r.watermark.lastRecordKey
      })),
      headSha: facts.head,
      dirtyHash: facts.dirtyHash
    };
    const cached = await this.opts.cache.get(cwd);
    if (cached && watermarksMatch(cached.watermark, watermark)) {
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
      facts
    };
  }

  async regenerate(args: GenerateOverviewArgs): Promise<WorktreeOverview> {
    const cwd = args.worktreeCwd;
    const existing = this.inFlightRegens.get(cwd);
    if (existing) {
      console.log('[overview.service] regenerate join in-flight', { cwd });
      return existing;
    }
    const promise = this.runRegenerate(cwd, args).finally(() => {
      this.inFlightRegens.delete(cwd);
    });
    this.inFlightRegens.set(cwd, promise);
    return promise;
  }

  private async runRegenerate(cwd: string, args: GenerateOverviewArgs): Promise<WorktreeOverview> {
    console.log('[overview.service] regenerate start', { cwd, runMode: args.runMode, wslDistro: args.wslDistro, baseBranch: args.baseBranch, openSessions: args.sessionFiles?.length ?? null });
    const scope = { runMode: args.runMode, wslDistro: args.wslDistro };
    const [refs, facts] = await Promise.all([
      this.listScopedOrAll(cwd, scope, args.sessionFiles),
      this.opts.facts.collect(cwd, args.baseBranch, scope)
    ]);
    console.log('[overview.service] sources collected', { sessionCount: refs.length, headSha: facts.head, branch: facts.branch });
    const transcripts = await Promise.all(refs.map((r) => this.opts.reader.readTranscript(r)));
    const built = buildOverviewPrompt({
      worktreeCwd: cwd,
      facts,
      transcripts
    });

    const settings = await this.opts.getSettings();
    const provider = await pickProvider(settings);
    console.log('[overview.service] provider picked', provider);
    if (!provider) {
      return {
        worktreeCwd: cwd,
        status: 'missing',
        text: null,
        generatedAt: null,
        generatedBy: null,
        watermark: null,
        sources: built.sources,
        facts,
        errorMessage: 'No Claude or Codex binary configured. Connect one in Settings → Agent integration.'
      };
    }

    const fullPrompt = `${built.systemPrompt}\n\n${built.contextText}\n\n${built.instruction}`;
    console.log('[overview.service] spawning agent', { provider: provider.provider, model: provider.id, promptBytes: fullPrompt.length });
    const result = await this.runOneShot({
      provider,
      prompt: fullPrompt,
      cwd,
      runMode: args.runMode ?? 'windows',
      wslDistro: args.wslDistro,
      binaries: settings.binaries,
      timeoutMs: OVERVIEW_TIMEOUT_MS
    }).catch((err: Error) => ({ ok: false as const, error: err.message }));
    console.log('[overview.service] runOneShot done', result.ok ? { ok: true, textBytes: result.text.length } : { ok: false, error: result.error });

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
        errorMessage: `Overview generation failed: ${result.error}`
      };
    }

    const watermark: OverviewWatermark = {
      perSession: refs.map((r) => ({
        sessionFile: r.sessionFile,
        lastRecordKey: r.watermark.lastRecordKey
      })),
      headSha: facts.head,
      dirtyHash: facts.dirtyHash
    };

    const entry: CachedOverviewEntry = {
      worktreeCwd: cwd,
      text: result.text,
      generatedAt: new Date().toISOString(),
      generatedBy: { provider: toAgentProvider(provider.provider), model: provider.id },
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

  async *streamFollowUp(args: StreamFollowUpArgs): AsyncIterable<FollowUpChunk> {
    const cwd = args.worktreeCwd;
    const scope = { runMode: args.runMode, wslDistro: args.wslDistro };
    const [refs, facts] = await Promise.all([
      this.listScopedOrAll(cwd, scope, args.sessionFiles),
      this.opts.facts.collect(cwd, args.baseBranch, scope)
    ]);
    const transcripts = await Promise.all(refs.map((r) => this.opts.reader.readTranscript(r)));
    const cached = await this.opts.cache.get(cwd);
    const built = buildFollowUpPrompt({
      worktreeCwd: cwd,
      facts,
      transcripts,
      history: args.history,
      message: args.message,
      cachedOverview: cached?.text
    });

    const settings = await this.opts.getSettings();
    const provider = await pickProvider(settings);
    if (!provider) {
      yield { type: 'error', error: 'No Claude or Codex binary configured.' };
      return;
    }

    const conversationText = built.conversation
      .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
      .join('\n\n');
    const fullPrompt = `${built.systemPrompt}\n\n${built.contextText}\n\n# Conversation\n${conversationText}\n\nASSISTANT:`;

    yield* this.streamOneShot({
      provider,
      prompt: fullPrompt,
      cwd,
      runMode: args.runMode ?? 'windows',
      wslDistro: args.wslDistro,
      binaries: settings.binaries,
      timeoutMs: FOLLOWUP_TIMEOUT_MS
    });
  }

  // Renderer hands us the transcript paths for sessions currently open in
  // the worktree; when that list is provided we trust it and skip the
  // historical scan. An empty array still means "scoped to nothing" — the
  // user explicitly has no agent tabs open here, and we'd rather show that
  // honestly than dredge up every transcript ever recorded.
  private async listScopedOrAll(
    cwd: string,
    scope: { runMode?: RunMode; wslDistro?: string },
    sessionFiles: string[] | undefined
  ) {
    if (sessionFiles) {
      return this.opts.reader.listScopedSessions(sessionFiles, cwd, scope);
    }
    return this.opts.reader.listAllSessions(cwd, scope);
  }

  private async runOneShot(args: RunArgs): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const { argv } = buildArgv(args.provider, args.binaries);
    console.log('[overview.service] runOneShot launch', {
      runMode: args.runMode,
      wslDistro: args.wslDistro,
      cwd: args.cwd,
      executable: argv.executable,
      argShape: argv.args.concat([`<stdin:${args.prompt.length} bytes>`])
    });
    return new Promise((resolve) => {
      const child = launch(argv, args, this.opts.spawnImpl ?? spawn);
      console.log('[overview.service] child spawned', { pid: child.pid });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn('[overview.service] timeout, killing', { pid: child.pid });
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({ ok: false, error: `overview generation timed out after ${args.timeoutMs}ms` });
      }, args.timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        console.error('[overview.service] child error', err);
        resolve({ ok: false, error: err.message });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        console.log('[overview.service] child closed', {
          code,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
          stdoutPreview: stdout.slice(0, 500),
          stderrPreview: stderr.slice(0, 500)
        });
        if (code !== 0) {
          // codex writes its errors to stdout, so fall back to stdout when
          // stderr is empty rather than hiding the real cause behind "exit N".
          const detail = (stderr.trim() || stdout.trim()).slice(0, 500);
          resolve({ ok: false, error: detail ? `${detail} (exit ${code})` : `exit ${code}` });
          return;
        }
        resolve({ ok: true, text: stdout.trim() });
      });
      writePromptToStdin(child, args.prompt);
    });
  }

  private async *streamOneShot(args: RunArgs): AsyncIterable<FollowUpChunk> {
    const { argv } = buildArgv(args.provider, args.binaries);
    const child = launch(argv, args, this.opts.spawnImpl ?? spawn);
    writePromptToStdin(child, args.prompt);
    const queue: FollowUpChunk[] = [];
    let resolveNext: (() => void) | null = null;
    let settled = false;
    let stderr = '';

    const push = (chunk: FollowUpChunk) => {
      queue.push(chunk);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      push({ type: 'error', error: `follow-up timed out after ${args.timeoutMs}ms` });
    }, args.timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      push({ type: 'delta', text: chunk });
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      push({ type: 'error', error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        push({ type: 'error', error: stderr.trim() || `exit ${code}` });
        return;
      }
      push({ type: 'done' });
    });

    while (true) {
      while (queue.length > 0) {
        const next = queue.shift()!;
        yield next;
        if (next.type === 'done' || next.type === 'error') return;
      }
      if (settled && queue.length === 0) return;
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
  }
}

interface RunArgs {
  provider: ModelSelection;
  prompt: string;
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
  binaries: SettingsBinaries;
  timeoutMs: number;
}

// The prompt is fed via stdin rather than tacked on as a positional arg —
// overview prompts can be ~MB, and on Windows that blows past the
// CreateProcess command-line limit (~32K) when we shell through wsl.exe.
// Both `codex exec` and `claude -p` read prompt text from stdin when no
// positional prompt is given.
function buildArgv(
  target: ModelSelection,
  binaries: SettingsBinaries
): { argv: { executable: string; args: string[] } } {
  if (target.provider === 'codex') {
    const exe = binaries.codex || 'codex';
    return {
      argv: {
        executable: exe,
        // No positional PROMPT → codex exec reads it from stdin.
        args: ['exec', '--skip-git-repo-check', '--color', 'never', '-m', target.id]
      }
    };
  }
  const exe = binaries.claude || 'claude';
  return {
    argv: {
      executable: exe,
      args: ['-p', '--model', target.id, '--output-format', 'text']
    }
  };
}

function writePromptToStdin(child: ChildProcess, prompt: string): void {
  const stdin = child.stdin;
  if (!stdin) return;
  stdin.on('error', () => { /* swallow EPIPE if child exits early */ });
  stdin.end(prompt, 'utf8');
}

function launch(
  argv: { executable: string; args: string[] },
  args: RunArgs,
  spawnImpl: typeof spawn
): ChildProcess {
  if (args.runMode === 'wsl') {
    const inner = buildWslAgentLine({}, argv.executable, argv.args);
    return spawnImpl(
      WslCommandBuilder.WSL_EXE,
      ['-d', args.wslDistro ?? 'Ubuntu', '--cd', args.cwd, 'bash', '-lc', inner],
      {
        cwd: process.env['USERPROFILE'] ?? process.env['HOME'] ?? os.homedir(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    );
  }
  return spawnImpl(argv.executable, argv.args, {
    cwd: args.cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
}

async function pickProvider(settings: Settings): Promise<ModelSelection | null> {
  const configured = settings.models.textGeneration ?? null;
  const codexAvailable = Boolean(settings.binaries.codex) || true;
  const claudeAvailable = Boolean(settings.binaries.claude) || true;
  if (configured) return configured;
  if (claudeAvailable) return { provider: 'claude', id: 'sonnet' };
  if (codexAvailable) return { provider: 'codex', id: 'gpt-5.4' };
  return null;
}

function dedupeProviders(arr: OverviewProvider[]): OverviewProvider[] {
  return [...new Set(arr)];
}

function toAgentProvider(p: ModelProvider): OverviewProvider {
  return p === 'claude' ? 'claude_code' : 'codex';
}
