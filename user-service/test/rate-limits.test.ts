import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  authRateLimits,
  createRateLimiters,
  DEFAULT_AUTH_LIMITS,
} from '../src/auth/rate-limiter.js';

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

  const raised = { loginPerIp: 1_000_000, loginPerEmail: 10, registerPerIp: 20 };

  it('lets a stack off production raise them, as the load test’s does', () => {
    expect(authRateLimits(raised, false)).toEqual(raised);
  });

  it('refuses to start in production with one raised above the policy', () => {
    expect(() => authRateLimits(raised, true)).toThrow(/LOGIN_LIMIT_PER_IP is 1000000.*at most 50/);
  });

  it('lets production tighten them', () => {
    const tighter = { loginPerIp: 20, loginPerEmail: 5, registerPerIp: 10 };
    expect(authRateLimits(tighter, true)).toEqual(tighter);
  });

  it('documents the policy in .env.example as the code has it', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    const documented = (name: string) =>
      Number(example.match(new RegExp(`^# ${name}=(\\d+)$`, 'm'))?.[1]);
    expect({
      loginPerIp: documented('LOGIN_LIMIT_PER_IP'),
      loginPerEmail: documented('LOGIN_LIMIT_PER_EMAIL'),
      registerPerIp: documented('REGISTER_LIMIT_PER_IP'),
    }).toEqual(DEFAULT_AUTH_LIMITS);
  });
});
