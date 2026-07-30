export type ReleaseGitProcess = () => void;

/**
 * Process-admission Module shared by every Git Adapter in the main process.
 *
 * Callers retain command-specific capture and parsing, while this Interface
 * keeps the expensive physical process topology bounded across repositories,
 * refresh generations, and evidence collection.
 */
export class GitProcessExecutor {
  private active = 0;
  private readonly queue: Array<{
    signal?: AbortSignal;
    resolve: (release: ReleaseGitProcess | null) => void;
    onAbort?: () => void;
  }> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Git process limit must be a positive integer');
    }
  }

  acquire(signal?: AbortSignal): Promise<ReleaseGitProcess | null> {
    if (signal?.aborted) return Promise.resolve(null);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise((resolve) => {
      const entry: (typeof this.queue)[number] = { signal, resolve };
      if (signal) {
        entry.onAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          resolve(null);
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.queue.push(entry);
    });
  }

  private makeRelease(): ReleaseGitProcess {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.admitNext();
    };
  }

  private admitNext(): void {
    while (this.active < this.limit) {
      const entry = this.queue.shift();
      if (!entry) return;
      if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort);
      if (entry.signal?.aborted) {
        entry.resolve(null);
        continue;
      }
      this.active += 1;
      entry.resolve(this.makeRelease());
    }
  }
}

// Two physical Git children are enough to overlap independent observations
// without allowing repository refreshes to amplify system process pressure.
export const SHARED_GIT_PROCESS_EXECUTOR = new GitProcessExecutor(2);
