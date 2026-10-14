import { CORRELATION_HEADER } from '@foc/platform';
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

/** How long an identity answer is reused when `cacheTtlMs` is not set. */
export const DEFAULT_CACHE_TTL_MS = 5_000;

interface Entry {
  value: Introspection;
  expiresAt: number;
  /** Lower-cased, as {@link IdentityClient.keysByUser} is keyed. */
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
 *   user the moment a `user.suspended` / `user.reactivated` / `user.role-changed` event arrives, so
 *   the window above is only the fallback when an event is late or lost.
 */
export class IdentityClient {
  private readonly cache = new Map<string, Entry>();
  /** The cache keys of each user (lower-cased id), so invalidating one user never scans the cache. */
  private readonly keysByUser = new Map<string, Set<string>>();
  private readonly inflight = new Map<string, Promise<Introspection>>();
  private readonly ttl: number;
  private readonly timeout: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: AuthConfig) {
    this.ttl = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeout = config.timeoutMs ?? 2_000;
    this.max = config.maxCacheEntries ?? 10_000;
    this.now = config.now ?? Date.now;
    this.fetchImpl = config.fetch ?? fetch;
  }

  /**
   * `correlationId` rides on the request to the User Service when one is made. A burst sharing one
   * lookup carries the first caller's ID; a cached answer makes no request at all.
   */
  async introspect(
    sessionId: string,
    userId: string,
    correlationId?: string,
  ): Promise<Introspection> {
    const key = `${sessionId}:${userId}`;

    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const request = this.fetchFresh(sessionId, userId, correlationId)
      .then((value) => {
        // Cached only if this lookup is still the current one: invalidateUser() detaches a lookup
        // that was in flight when it ran, because its answer may predate the event.
        if (this.inflight.get(key) === request) this.remember(key, userId, value);
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
    // A UUID is case-insensitive; token subjects are lower-case, and so is every index here.
    const id = userId.toLowerCase();
    for (const key of this.keysByUser.get(id) ?? []) this.cache.delete(key);
    this.keysByUser.delete(id);
    for (const key of this.inflight.keys()) {
      if (key.toLowerCase().endsWith(`:${id}`)) this.inflight.delete(key);
    }
  }

  private async fetchFresh(
    sessionId: string,
    userId: string,
    correlationId: string | undefined,
  ): Promise<Introspection> {
    const url = new URL('/internal/introspect', this.config.userServiceUrl);
    url.searchParams.set('sid', sessionId);
    url.searchParams.set('sub', userId);

    let body: unknown;
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          'x-service-key': this.config.serviceKey,
          accept: 'application/json',
          ...(correlationId ? { [CORRELATION_HEADER]: correlationId } : {}),
        },
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
      for (const [k, e] of this.cache) if (e.expiresAt <= now) this.forget(k);
      const oldest = this.cache.keys().next().value;
      if (this.cache.size >= this.max && oldest !== undefined) this.forget(oldest);
    }
    const id = userId.toLowerCase();
    this.cache.set(key, { value, userId: id, expiresAt: this.now() + this.ttl });
    const keys = this.keysByUser.get(id);
    if (keys) keys.add(key);
    else this.keysByUser.set(id, new Set([key]));
  }

  private forget(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    const keys = this.keysByUser.get(entry.userId);
    keys?.delete(key);
    if (keys?.size === 0) this.keysByUser.delete(entry.userId);
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
