/** Resolves renderer writes only after the native terminal parser acknowledges them. */
export class NativeWriteCompletion {
  private readonly pending = new Map<number, () => void>();
  private readonly completed = new Set<number>();
  private disposed = false;

  wait(ticket: number): Promise<void> {
    if (this.disposed || ticket === 0) return Promise.resolve();
    if (this.completed.delete(ticket)) return Promise.resolve();
    return new Promise((resolve) => this.pending.set(ticket, resolve));
  }

  complete(ticket: number): void {
    if (this.disposed || ticket === 0) return;
    const resolve = this.pending.get(ticket);
    if (resolve) {
      this.pending.delete(ticket);
      resolve();
      return;
    }
    this.completed.add(ticket);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resolve of this.pending.values()) resolve();
    this.pending.clear();
    this.completed.clear();
  }
}
