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
  /** Password re-entry (`POST /auth/step-up`) is a password oracle too, so it is limited per user. */
  stepUpPerUser: RateLimiter;
}

export const RATE_LIMITERS = Symbol('RATE_LIMITERS');

/**
 * How many sign-ins (per 15 minutes) and sign-ups (per hour) one address or account may make. The
 * defaults are the agreed policy, and this is the one place they are written: the configuration's
 * defaults are these. Off production, configuration may raise them, as the load test (TST-03) does
 * for its 100 virtual users signing in from one machine; production may only tighten them.
 */
export interface AuthRateLimits {
  loginPerIp: number;
  loginPerEmail: number;
  registerPerIp: number;
}

export const DEFAULT_AUTH_LIMITS: AuthRateLimits = {
  loginPerIp: 50,
  loginPerEmail: 10,
  registerPerIp: 20,
};

const VARIABLES: Record<keyof AuthRateLimits, string> = {
  loginPerIp: 'LOGIN_LIMIT_PER_IP',
  loginPerEmail: 'LOGIN_LIMIT_PER_EMAIL',
  registerPerIp: 'REGISTER_LIMIT_PER_IP',
};

/**
 * The limits configuration asks for, if this environment may have them. They are the defence
 * against guessing passwords (US-NFR2), so in production one above the policy stops the service
 * starting rather than switch that defence off.
 */
export function authRateLimits(configured: AuthRateLimits, production: boolean): AuthRateLimits {
  if (!production) return configured;
  const raised = (Object.keys(VARIABLES) as Array<keyof AuthRateLimits>)
    .filter((limit) => configured[limit] > DEFAULT_AUTH_LIMITS[limit])
    .map(
      (limit) =>
        `${VARIABLES[limit]} is ${configured[limit]}, at most ${DEFAULT_AUTH_LIMITS[limit]}`,
    );
  if (raised.length > 0) {
    throw new Error(
      `Sign-in and sign-up limits above the policy in production: ${raised.join('; ')}. ` +
        'Only a stack off production, such as the load test’s, may raise them.',
    );
  }
  return configured;
}

export const createRateLimiters = (
  limits: AuthRateLimits = DEFAULT_AUTH_LIMITS,
): AuthRateLimiters => ({
  loginPerEmail: new RateLimiter(limits.loginPerEmail, 15 * 60_000),
  loginPerIp: new RateLimiter(limits.loginPerIp, 15 * 60_000),
  registerPerIp: new RateLimiter(limits.registerPerIp, 60 * 60_000),
  stepUpPerUser: new RateLimiter(10, 15 * 60_000),
});
