export interface GroupedTaskOptions {
  /** Tasks sharing a resource group, such as one WSL distro, are serialized. */
  group?: string;
  /** Higher priorities acquire newly available capacity first. */
  priority?: number;
}

interface QueuedTask<TResult> {
  sequence: number;
  group?: string;
  priority: number;
  task: () => Promise<TResult> | TResult;
  resolve: (result: TResult | PromiseLike<TResult>) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Small shared process budget for unrelated Git operations. It is deliberately
 * unaware of Git semantics; callers provide only resource grouping and urgency.
 */
export class GroupedTaskPool {
  private readonly queue: Array<QueuedTask<unknown>> = [];
  private readonly activeByGroup = new Map<string, number>();
  private active = 0;
  private sequence = 0;

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxPerGroup = 1
  ) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error('maxConcurrency must be a positive integer');
    }
    if (!Number.isInteger(maxPerGroup) || maxPerGroup < 1) {
      throw new Error('maxPerGroup must be a positive integer');
    }
  }

  run<TResult>(
    task: () => Promise<TResult> | TResult,
    options: GroupedTaskOptions = {}
  ): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      const entry: QueuedTask<TResult> = {
        sequence: this.sequence++,
        priority: options.priority ?? 0,
        task,
        resolve,
        reject,
        ...(options.group ? { group: options.group } : {})
      };
      this.queue.push(entry as QueuedTask<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.maxConcurrency) {
      const index = this.nextEligibleIndex();
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      if (!entry) return;
      this.active += 1;
      if (entry.group) {
        this.activeByGroup.set(entry.group, (this.activeByGroup.get(entry.group) ?? 0) + 1);
      }
      void Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active = Math.max(0, this.active - 1);
          if (entry.group) decrementGroup(this.activeByGroup, entry.group);
          this.drain();
        });
    }
  }

  private nextEligibleIndex(): number {
    let selected = -1;
    for (let index = 0; index < this.queue.length; index += 1) {
      const candidate = this.queue[index];
      if (!candidate || !this.groupAvailable(candidate.group)) continue;
      const current = selected < 0 ? undefined : this.queue[selected];
      if (
        !current ||
        candidate.priority > current.priority ||
        (candidate.priority === current.priority && candidate.sequence < current.sequence)
      ) {
        selected = index;
      }
    }
    return selected;
  }

  private groupAvailable(group: string | undefined): boolean {
    return !group || (this.activeByGroup.get(group) ?? 0) < this.maxPerGroup;
  }
}

function decrementGroup(activeByGroup: Map<string, number>, group: string): void {
  const remaining = (activeByGroup.get(group) ?? 1) - 1;
  if (remaining > 0) activeByGroup.set(group, remaining);
  else activeByGroup.delete(group);
}
