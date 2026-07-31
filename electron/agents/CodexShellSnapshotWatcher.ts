import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CODEX_THREAD_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[.-]|$)/iu;
const SAFE_SOLOE_SESSION_ID = /^[a-z0-9._:-]{1,256}$/iu;
const READ_RETRY_MS = 40;
const READ_RETRIES = 5;

export interface CodexShellSnapshotThread {
  soloeSessionId: string;
  providerThreadId: string;
}

export interface CodexShellSnapshotWatcherOptions {
  directory: string;
  onThread: (thread: CodexShellSnapshotThread) => void | Promise<void>;
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

  constructor(private readonly opts: CodexShellSnapshotWatcherOptions) {}

  async start(): Promise<void> {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.opts.directory, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        void this.inspect(String(filename));
      });
      this.watcher.on('error', (error) => {
        this.opts.log?.('Codex shell snapshot watcher failed', error);
      });
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
  }

  private async inspect(filename: string, attempt = 0): Promise<void> {
    const threadId = threadIdFromFilename(filename);
    if (!threadId) return;
    try {
      const contents = await readFile(join(this.opts.directory, filename), 'utf8');
      const thread = parseCodexShellSnapshot(filename, contents);
      if (!thread) {
        if (attempt < READ_RETRIES) this.retry(filename, attempt);
        return;
      }
      if (this.lastThreadBySession.get(thread.soloeSessionId) === thread.providerThreadId) return;
      this.lastThreadBySession.set(thread.soloeSessionId, thread.providerThreadId);
      await this.opts.onThread(thread);
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
      void this.inspect(filename, attempt + 1);
    }, READ_RETRY_MS);
    this.retries.add(retry);
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

function firstCapture(match: RegExpMatchArray | null): string | null {
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}
