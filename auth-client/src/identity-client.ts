import { authFailure } from './errors.js';
import type { AccountStatus, AuthConfig, Role } from './types.js';

export type Introspection =
  | { active: false }
  | { active: true; userId: string; status: AccountStatus; roles: Role[]; displayName: string };

interface Entry {
  value: Introspection;
  expiresAt: number;
}

/**
 * Asks the User Service whether a session is live and who is behind it
 * (`GET /internal/introspect`), and remembers the answer for a short, bounded time.
 *
 * - **Bounded staleness.** An answer is reused for at most `cacheTtlMs` (default 5 s), so a
 *   suspension or logout is enforced here within that window. Nothing is cached longer.
 * - **Single-flight.** A burst of requests for one session makes one call, not one each.
 * - **Fail closed.** A timeout, a network error, a non-200 or a malformed reply throws
 *   `IDENTITY_UNAVAILABLE` and is *not* cached, so the next request retries.
 */
export class IdentityClient {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Introspection>>();
  private readonly ttl: number;
  private readonly timeout: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: AuthConfig) {
    this.ttl = config.cacheTtlMs ?? 5_000;
    this.timeout = config.timeoutMs ?? 2_000;
    this.max = config.maxCacheEntries ?? 10_000;
    this.now = config.now ?? Date.now;
    this.fetchImpl = config.fetch ?? fetch;
  }

  async introspect(sessionId: string, userId: string): Promise<Introspection> {
    const key = `${sessionId}:${userId}`;

    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const request = this.fetchFresh(sessionId, userId)
      .then((value) => {
        this.remember(key, value);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  private async fetchFresh(sessionId: string, userId: string): Promise<Introspection> {
    const url = new URL('/internal/introspect', this.config.userServiceUrl);
    url.searchParams.set('sid', sessionId);
    url.searchParams.set('sub', userId);

    let body: unknown;
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'x-service-key': this.config.serviceKey, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!res.ok) throw new Error(`introspect responded ${res.status}`);
      body = await res.json();
    } catch {
      throw authFailure('IDENTITY_UNAVAILABLE');
    }
    return parse(body);
  }

  private remember(key: string, value: Introspection): void {
    if (this.ttl <= 0) return;
    if (this.cache.size >= this.max) {
      // Drop expired entries first; if still full, drop the oldest. Insertion order is age order.
      const now = this.now();
      for (const [k, e] of this.cache) if (e.expiresAt <= now) this.cache.delete(k);
      const oldest = this.cache.keys().next().value;
      if (this.cache.size >= this.max && oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt: this.now() + this.ttl });
  }
}

const STATUSES = new Set<string>(['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED']);
const ROLES = new Set<string>(['STUDENT', 'ADMIN']);

/** Trust nothing about the shape of the reply: an unexpected body fails closed rather than granting access. */
function parse(body: unknown): Introspection {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || typeof b.active !== 'boolean') {
    throw authFailure('IDENTITY_UNAVAILABLE');
  }
  if (!b.active) return { active: false };
  if (
    typeof b.userId !== 'string' ||
    typeof b.displayName !== 'string' ||
    typeof b.status !== 'string' ||
    !STATUSES.has(b.status) ||
    !Array.isArray(b.roles) ||
    !b.roles.every((r) => typeof r === 'string' && ROLES.has(r))
  ) {
    throw authFailure('IDENTITY_UNAVAILABLE');
  }
  return {
    active: true,
    userId: b.userId,
    status: b.status as AccountStatus,
    roles: b.roles as Role[],
    displayName: b.displayName,
  };
}
