import { describe, expect, it } from 'vitest';
import { createRateLimiters, DEFAULT_AUTH_LIMITS } from '../src/auth/rate-limiter.js';

/** How many times a key may act in one window before it is refused. */
const allowed = (limiter: { hit: (key: string) => { allowed: boolean } }) => {
  let count = 0;
  while (limiter.hit('key').allowed) count++;
  return count;
};

describe('sign-in and sign-up limits (US-NFR2)', () => {
  it('keeps the agreed limits when nothing configures them', () => {
    const limiters = createRateLimiters();
    expect(allowed(limiters.loginPerIp)).toBe(50);
    expect(allowed(limiters.loginPerEmail)).toBe(10);
    expect(allowed(limiters.registerPerIp)).toBe(20);
    expect(allowed(limiters.stepUpPerUser)).toBe(10);
    expect(DEFAULT_AUTH_LIMITS).toEqual({ loginPerIp: 50, loginPerEmail: 10, registerPerIp: 20 });
  });

  it('takes the sign-in and sign-up limits from configuration, as the load test raises them', () => {
    const limiters = createRateLimiters({
      loginPerIp: 300,
      loginPerEmail: 120,
      registerPerIp: 150,
    });
    expect(allowed(limiters.loginPerIp)).toBe(300);
    expect(allowed(limiters.loginPerEmail)).toBe(120);
    expect(allowed(limiters.registerPerIp)).toBe(150);
    // Password re-entry is not a sign-in: configuration never loosens it.
    expect(allowed(limiters.stepUpPerUser)).toBe(10);
  });
});
