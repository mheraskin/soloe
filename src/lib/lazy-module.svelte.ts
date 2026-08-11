export type ModuleLoader<T> = () => Promise<T>;

/**
 * Owns one lazy import lifecycle. Callers get a small interface while request
 * coalescing, failure capture, and retry behavior stay local to this module.
 */
export class LazyModule<T> {
  value = $state<T | null>(null);
  error = $state<Error | null>(null);
  loading = $state(false);

  private pending: Promise<T | null> | null = null;

  constructor(private readonly loader: ModuleLoader<T>) {}

  load(): Promise<T | null> {
    if (this.value) return Promise.resolve(this.value);
    if (this.pending) return this.pending;

    this.loading = true;
    this.error = null;
    const request = this.loader()
      .then((value) => {
        this.value = value;
        return value;
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error : new Error(String(error));
        return null;
      })
      .finally(() => {
        if (this.pending === request) this.pending = null;
        this.loading = false;
      });
    this.pending = request;
    return request;
  }
}
