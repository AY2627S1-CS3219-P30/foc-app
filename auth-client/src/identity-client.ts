import { authFailure } from './errors.js';
import type { AuthConfig, Role } from './types.js';

export type Introspection =
  | { active: false }
  | {
      active: true;
      userId: string;
      /**
       * Deliberately a plain string: the User Service may add a status later (additive
       * changes are expected in v1). Anything other than `ACTIVE` or `SUSPENDED` is denied
       * as not-active by the authenticator rather than treated as an outage.
       */
      status: string;
      roles: Role[];
      displayName: string;
    };

interface Entry {
  value: Introspection;
  expiresAt: number;
  userId: string;
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
 * - **Event-driven invalidation (USR-07).** {@link invalidateUser} drops everything known about a
 *   user the moment a `user.suspended` / `user.reactivated` event arrives, so the window above is
 *   only the fallback when an event is late or lost.
 */
export class IdentityClient {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Introspection>>();
  /**
   * Bumped by {@link invalidateUser}. A lookup that was already in flight when the event arrived
   * may carry the pre-event answer, so it is not cached if the user's generation moved meanwhile.
   */
  private readonly generations = new Map<string, number>();
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

    const generation = this.generations.get(userId) ?? 0;
    const request = this.fetchFresh(sessionId, userId)
      .then((value) => {
        if ((this.generations.get(userId) ?? 0) === generation) this.remember(key, userId, value);
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === request) this.inflight.delete(key);
      });
    this.inflight.set(key, request);
    return request;
  }

  /**
   * Forgets every cached answer for this user, across all their sessions, and detaches any lookup
   * already in flight so the next request asks the User Service afresh. Cheap and idempotent.
   */
  invalidateUser(userId: string): void {
    this.generations.set(userId, (this.generations.get(userId) ?? 0) + 1);
    for (const [k, e] of this.cache) if (e.userId === userId) this.cache.delete(k);
    for (const k of this.inflight.keys()) if (k.endsWith(`:${userId}`)) this.inflight.delete(k);
    // Bounded like the cache: generations only matter while a lookup is in flight.
    if (this.generations.size > this.max) this.generations.clear();
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

  private remember(key: string, userId: string, value: Introspection): void {
    if (this.ttl <= 0) return;
    if (this.cache.size >= this.max) {
      // Drop expired entries first; if still full, drop the oldest. Insertion order is age order.
      const now = this.now();
      for (const [k, e] of this.cache) if (e.expiresAt <= now) this.cache.delete(k);
      const oldest = this.cache.keys().next().value;
      if (this.cache.size >= this.max && oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, userId, expiresAt: this.now() + this.ttl });
  }
}

const ROLES = new Set<string>(['STUDENT', 'ADMIN']);

/**
 * Trust nothing about the *shape* of the reply: a body that is not an introspection at all fails
 * closed as unavailable. But a new status or role is an expected, additive change and is handled as
 * an authorization outcome (deny / ignore), never as an outage.
 */
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
    !Array.isArray(b.roles)
  ) {
    throw authFailure('IDENTITY_UNAVAILABLE');
  }
  return {
    active: true,
    userId: b.userId,
    status: b.status,
    // A role this package does not know grants nothing here; drop it rather than reject the whole reply.
    roles: b.roles.filter((r): r is Role => typeof r === 'string' && ROLES.has(r)),
    displayName: b.displayName,
  };
}
