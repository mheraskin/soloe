import { watch, type FSWatcher } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CODEX_THREAD_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[.-]|$)/iu;
const SAFE_SOLOE_SESSION_ID = /^[a-z0-9._:-]{1,256}$/iu;
const READ_RETRY_MS = 40;
const READ_RETRIES = 5;
const COMPLETE_SNAPSHOT = /^[0-9a-f-]+\.([0-9]+)\.sh$/iu;

export interface CodexShellSnapshotThread {
  soloeSessionId: string;
  providerThreadId: string;
}

export interface CodexShellSnapshotWatcherOptions {
  directory: string;
  onThread: (thread: CodexShellSnapshotThread) => void | Promise<void>;
  isThreadDurable?: (thread: CodexShellSnapshotThread) => boolean | Promise<boolean>;
  log?: (message: string, detail?: unknown) => void;
}

export function codexShellSnapshotDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir()
): string {
  const codexHome = env.CODEX_HOME?.trim() || join(homeDirectory, '.codex');
  return join(codexHome, 'shell_snapshots');
}

export class CodexShellSnapshotWatcher {
  private watcher: FSWatcher | null = null;
  private readonly retries = new Set<ReturnType<typeof setTimeout>>();
  private readonly lastThreadBySession = new Map<string, string>();
  private readonly lastSnapshotOrderBySession = new Map<string, bigint>();
  private inspectionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: CodexShellSnapshotWatcherOptions) {}

  async start(): Promise<void> {
    if (this.watcher) return;
    try {
      const bufferedFilenames = new Set<string>();
      let reconciling = true;
      this.watcher = watch(this.opts.directory, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        const value = String(filename);
        if (reconciling) bufferedFilenames.add(value);
        else this.enqueue(value);
      });
      this.watcher.on('error', (error) => {
        this.opts.log?.('Codex shell snapshot watcher failed', error);
      });
      try {
        const existing = await readdir(this.opts.directory);
        existing.sort((a, b) => compareSnapshotOrder(b, a));
        for (const filename of existing) {
          await this.inspect(filename);
        }
      } finally {
        reconciling = false;
        for (const filename of bufferedFilenames) this.enqueue(filename);
      }
    } catch (error) {
      this.opts.log?.('Codex shell snapshot directory is unavailable', error);
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const retry of this.retries) clearTimeout(retry);
    this.retries.clear();
    this.lastThreadBySession.clear();
    this.lastSnapshotOrderBySession.clear();
    this.inspectionQueue = Promise.resolve();
  }

  private async inspect(filename: string, attempt = 0): Promise<void> {
    const order = snapshotOrder(filename);
    if (order === null) return;
    const threadId = threadIdFromFilename(filename);
    if (!threadId) return;
    try {
      const contents = await readFile(join(this.opts.directory, filename), 'utf8');
      const thread = parseCodexShellSnapshot(filename, contents);
      if (!thread) {
        if (attempt < READ_RETRIES) this.retry(filename, attempt);
        return;
      }
      if (this.opts.isThreadDurable && !await this.opts.isThreadDurable(thread)) {
        if (attempt < READ_RETRIES) this.retry(filename, attempt);
        return;
      }
      const previousOrder = this.lastSnapshotOrderBySession.get(thread.soloeSessionId);
      if (previousOrder !== undefined && order <= previousOrder) return;
      if (this.lastThreadBySession.get(thread.soloeSessionId) === thread.providerThreadId) {
        this.lastSnapshotOrderBySession.set(thread.soloeSessionId, order);
        return;
      }
      await this.opts.onThread(thread);
      this.lastThreadBySession.set(thread.soloeSessionId, thread.providerThreadId);
      this.lastSnapshotOrderBySession.set(thread.soloeSessionId, order);
    } catch (error) {
      if (attempt < READ_RETRIES) {
        this.retry(filename, attempt);
        return;
      }
      this.opts.log?.('Failed to read Codex shell snapshot', error);
    }
  }

  private retry(filename: string, attempt: number): void {
    const retry = setTimeout(() => {
      this.retries.delete(retry);
      this.enqueue(filename, attempt + 1);
    }, READ_RETRY_MS);
    this.retries.add(retry);
  }

  private enqueue(filename: string, attempt = 0): void {
    this.inspectionQueue = this.inspectionQueue
      .then(() => this.inspect(filename, attempt))
      .catch((error) => this.opts.log?.('Failed to inspect Codex shell snapshot', error));
  }
}

export function parseCodexShellSnapshot(
  filename: string,
  contents: string
): CodexShellSnapshotThread | null {
  const providerThreadId = threadIdFromFilename(filename);
  if (!providerThreadId) return null;
  const bashMatch = contents.match(
    /(?:^|\n)\s*(?:declare\s+-x\s+|export\s+)?SOLOE_SESSION_ID=(?:'([^']+)'|"([^"]+)"|([^\s\r\n]+))/u
  );
  const powershellMatch = contents.match(
    /(?:^|\n)\s*\$Env:SOLOE_SESSION_ID\s*=\s*(?:'([^']+)'|"([^"]+)"|([^\s\r\n]+))/iu
  );
  const soloeSessionId = firstCapture(bashMatch) ?? firstCapture(powershellMatch);
  if (!soloeSessionId || !SAFE_SOLOE_SESSION_ID.test(soloeSessionId)) return null;
  return { soloeSessionId, providerThreadId };
}

function threadIdFromFilename(filename: string): string | null {
  return filename.match(CODEX_THREAD_ID)?.[1] ?? null;
}

function snapshotOrder(filename: string): bigint | null {
  const match = filename.match(COMPLETE_SNAPSHOT);
  return match?.[1] ? BigInt(match[1]) : null;
}

function compareSnapshotOrder(a: string, b: string): number {
  const left = snapshotOrder(a) ?? -1n;
  const right = snapshotOrder(b) ?? -1n;
  return left === right ? 0 : left < right ? -1 : 1;
}

function firstCapture(match: RegExpMatchArray | null): string | null {
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}
