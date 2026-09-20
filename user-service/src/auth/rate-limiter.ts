/**
 * A fixed-window counter per key. In memory, so it is per instance: correct for
 * one User Service replica, and the reason a horizontally scaled deployment
 * would move this to the gateway or a shared store.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetsAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt. `allowed` is false once the key is over its limit for the window. */
  hit(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    if (this.windows.size > 10_000) this.prune(now);

    let w = this.windows.get(key);
    if (!w || w.resetsAt <= now) {
      w = { count: 0, resetsAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    return {
      allowed: w.count <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((w.resetsAt - now) / 1000)),
    };
  }

  private prune(now: number): void {
    for (const [k, w] of this.windows) if (w.resetsAt <= now) this.windows.delete(k);
  }
}

export interface AuthRateLimiters {
  loginPerEmail: RateLimiter;
  loginPerIp: RateLimiter;
  registerPerIp: RateLimiter;
}

export const RATE_LIMITERS = Symbol('RATE_LIMITERS');

export const defaultRateLimiters = (): AuthRateLimiters => ({
  loginPerEmail: new RateLimiter(10, 15 * 60_000),
  loginPerIp: new RateLimiter(50, 15 * 60_000),
  registerPerIp: new RateLimiter(20, 60 * 60_000),
});
