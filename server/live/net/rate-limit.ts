/**
 * Minimum-interval limiter (VL-004B-prep): every HTTP attempt to a quota-bound provider — first tries,
 * retries after 429/5xx, everything — waits until `intervalMs` has passed since the previous attempt
 * STARTED. Callers are serialised (a promise chain), so concurrent callers in one process can never burst.
 * Search API sync quota is 1 request/second; the default interval 1100 ms keeps a 10 % margin.
 * Across processes, parallel paid execution is refused altogether (see paid-lock.ts).
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export class MinIntervalLimiter {
  private last = Number.NEGATIVE_INFINITY;
  private chain: Promise<void> = Promise.resolve();
  /** Start times of every granted slot (audit / tests). */
  readonly granted: number[] = [];

  constructor(readonly intervalMs: number, private readonly clock: Clock = realClock) {
    if (!(intervalMs >= 0)) throw new Error('intervalMs must be ≥ 0');
  }

  /** Resolves when the caller may start ONE request. */
  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      const wait = this.last + this.intervalMs - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      this.last = this.clock.now();
      this.granted.push(this.last);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}
