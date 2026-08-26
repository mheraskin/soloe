export type RemoteTerminalInputPriority = 'text' | 'immediate' | 'protocol';

const DEFAULT_BATCH_WINDOW_MS = 20;

/**
 * Coalesces ordinary text for one short paint-sized window while preserving a
 * single ordered stream. Immediate input drains queued text in the same write,
 * so Enter, Escape, terminal replies, mouse reports, and TUI scrolling never
 * wait behind the batching timer.
 */
export class RemoteTerminalInputBatcher {
  private pendingText = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly send: (data: string) => void,
    private readonly batchWindowMs = DEFAULT_BATCH_WINDOW_MS
  ) {}

  submit(data: string, priority: RemoteTerminalInputPriority): void {
    if (this.disposed || data.length === 0) return;
    if (priority === 'protocol') {
      this.send(data);
      return;
    }
    if (priority === 'immediate') {
      const ordered = this.takePendingText() + data;
      this.send(ordered);
      return;
    }
    this.pendingText += data;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.batchWindowMs);
  }

  flush(): void {
    if (this.disposed && this.pendingText.length === 0) return;
    const pending = this.takePendingText();
    if (pending.length > 0) this.send(pending);
  }

  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
  }

  private takePendingText(): string {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const pending = this.pendingText;
    this.pendingText = '';
    return pending;
  }
}
