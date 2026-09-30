import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope, EVENTS, type UserStatusChangedPayload } from '@foc/platform';
import {
  authStatusEvents,
  createAuthenticator,
  UserStatusInvalidation,
  type AuthConfig,
  type Authenticator,
} from '../src/index.js';
import {
  SERVICE_KEY,
  startFakeUserService,
  type FakeUserService,
} from './helpers/fake-user-service.js';

let fake: FakeUserService;
beforeAll(async () => {
  fake = await startFakeUserService();
});
afterAll(async () => fake.close());
beforeEach(() => {
  fake.behaviour.introspectDelayMs = 0;
  fake.stats.introspectCalls = 0;
});

let now = 0;
const make = (over: Partial<AuthConfig> = {}) =>
  createAuthenticator({
    userServiceUrl: fake.url,
    serviceKey: SERVICE_KEY,
    jwksCooldownMs: 0,
    cacheTtlMs: 5_000,
    now: () => now,
    ...over,
  });

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? `UNTYPED:${String(e)}`;
  }
}

/** Builds the handler as a service would get it, with no broker: the consumer is never called here. */
function handlerFor(auth: Authenticator) {
  const noConsumer = {} as never;
  return new UserStatusInvalidation(noConsumer, auth, 'foc.test.auth-status');
}

function statusEvent(userId: string, status: 'ACTIVE' | 'SUSPENDED') {
  return createEnvelope({
    eventType: status === 'SUSPENDED' ? EVENTS.USER_SUSPENDED : EVENTS.USER_REACTIVATED,
    schemaVersion: 1,
    aggregateId: userId,
    producer: 'user-service',
    correlationId: randomUUID(),
    payload: {
      userId,
      status,
      reasonRef: randomUUID(),
      occurredAt: new Date().toISOString(),
    } satisfies UserStatusChangedPayload,
  });
}

describe('event-driven invalidation (USR-07)', () => {
  it('a suspension is enforced on the very next request, not after the cache window', async () => {
    now = 0;
    const auth = make();
    const alex = await fake.login();
    const header = `Bearer ${alex.token}`;
    expect(await outcome(auth.authenticate(header))).toBe('OK'); // cached for 5 s

    fake.sessions.get(alex.sid)!.status = 'SUSPENDED';
    now = 100; // well inside the window: without the event the stale ACTIVE answer would be reused
    expect(await outcome(auth.authenticate(header))).toBe('OK');

    handlerFor(auth).handle(statusEvent(alex.userId, 'SUSPENDED') as never);
    expect(await outcome(auth.authenticate(header))).toBe('ACCOUNT_SUSPENDED');
  });

  it('a reactivation lets the user straight back in', async () => {
    now = 0;
    const auth = make();
    const alex = await fake.login({ status: 'SUSPENDED' });
    const header = `Bearer ${alex.token}`;
    expect(await outcome(auth.authenticate(header))).toBe('ACCOUNT_SUSPENDED');

    fake.sessions.get(alex.sid)!.status = 'ACTIVE';
    handlerFor(auth).handle(statusEvent(alex.userId, 'ACTIVE') as never);
    expect(await outcome(auth.authenticate(header))).toBe('OK');
  });

  it('drops every session of that user, and only that user', async () => {
    now = 0;
    const auth = make();
    const phone = await fake.login();
    const laptop = fake.addSession({ userId: phone.userId });
    const laptopToken = await fake.mint(laptop);
    const other = await fake.login();
    for (const t of [phone.token, laptopToken, other.token]) await auth.authenticate(`Bearer ${t}`);
    const before = fake.stats.introspectCalls;

    handlerFor(auth).handle(statusEvent(phone.userId, 'SUSPENDED') as never);
    for (const t of [phone.token, laptopToken, other.token]) await auth.authenticate(`Bearer ${t}`);
    // Both of the user's sessions were re-checked; the bystander was served from cache.
    expect(fake.stats.introspectCalls - before).toBe(2);
  });

  it('never caches an answer that was in flight when the event arrived', async () => {
    now = 0;
    // The User Service answers ACTIVE, but the reply is held on the wire until after the event.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let hold = true;
    const auth = make({
      fetch: async (url, init) => {
        const res = await fetch(url, init);
        if (hold && String(url).includes('/internal/introspect')) await held;
        return res;
      },
    });
    const alex = await fake.login();
    const header = `Bearer ${alex.token}`;

    const inFlight = auth.authenticate(header);
    await new Promise((r) => setTimeout(r, 50)); // the ACTIVE answer has been produced
    fake.sessions.get(alex.sid)!.status = 'SUSPENDED';
    handlerFor(auth).handle(statusEvent(alex.userId, 'SUSPENDED') as never);
    hold = false;
    release();
    expect(await outcome(inFlight)).toBe('OK'); // that one request was already decided

    // ... but its stale answer was not cached, so the next request sees the suspension.
    expect(await outcome(auth.authenticate(header))).toBe('ACCOUNT_SUSPENDED');
  });

  it('decides nothing from the event: a forged "reactivated" cannot let a suspended user in', async () => {
    now = 0;
    const auth = make();
    const mallory = await fake.login({ status: 'SUSPENDED' });
    handlerFor(auth).handle(statusEvent(mallory.userId, 'ACTIVE') as never);
    expect(await outcome(auth.authenticate(`Bearer ${mallory.token}`))).toBe('ACCOUNT_SUSPENDED');
  });

  it('is idempotent and harmless for a user nobody has cached', () => {
    const auth = make();
    const handler = handlerFor(auth);
    const event = statusEvent(randomUUID(), 'SUSPENDED') as never;
    expect(() => {
      handler.handle(event);
      handler.handle(event);
    }).not.toThrow();
  });
});

describe('authStatusEvents', () => {
  it('gives each service its own queue bound to both status events', () => {
    const order = authStatusEvents('order');
    const credit = authStatusEvents('credit');
    expect(order.subscription).toEqual({
      queue: 'foc.order.auth-status',
      routingKeys: [EVENTS.USER_SUSPENDED, EVENTS.USER_REACTIVATED],
    });
    expect(credit.subscription.queue).not.toBe(order.subscription.queue);
    expect(order.providers).toContain(UserStatusInvalidation);
  });
});
