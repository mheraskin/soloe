// One shared coarse clock for relative timestamps. A single interval keeps
// every "5m ago" label honest without each row owning a timer, and it only
// runs while something is actually reading `now`.
const TICK_MS = 30_000;

class ClockStore {
  #now = $state(Date.now());
  #timer: ReturnType<typeof setInterval> | null = null;
  #readers = 0;

  // Reactive current time, coarse to 30s. Read inside a $derived/$effect.
  get now(): number {
    return this.#now;
  }

  // Keeps the interval alive for the lifetime of the calling component.
  // Call from component init: `clock.subscribe()` inside `$effect`.
  subscribe(): () => void {
    this.#readers += 1;
    if (this.#timer === null && typeof setInterval === 'function') {
      this.#timer = setInterval(() => {
        this.#now = Date.now();
      }, TICK_MS);
    }
    return () => {
      this.#readers -= 1;
      if (this.#readers > 0 || this.#timer === null) return;
      clearInterval(this.#timer);
      this.#timer = null;
    };
  }
}

export const clock = new ClockStore();
