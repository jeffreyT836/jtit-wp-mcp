/**
 * Fixed-window in-memory rate limiter keyed by e.g. client IP. Single process, so memory is
 * fine; Traefik adds a coarser limit in front.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit; returns false when `key` is over the limit for the current window. */
  take(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private sweep(now: number): void {
    if (this.hits.size < 1000) return;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }
}
