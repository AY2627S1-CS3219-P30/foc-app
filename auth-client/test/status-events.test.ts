import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createEnvelope,
  EVENT_CONSUMER,
  EVENTS,
  type SubscribeOptions,
  type UserRoleChangedPayload,
  type UserStatusChangedPayload,
} from '@foc/platform';
import {
  AUTHENTICATOR,
  authStatusEvents,
  AuthModule,
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
const config = (over: Partial<AuthConfig> = {}): AuthConfig => ({
  userServiceUrl: fake.url,
  serviceKey: SERVICE_KEY,
  jwksCooldownMs: 0,
  cacheTtlMs: 5_000,
  now: () => now,
  ...over,
});
const make = (over: Partial<AuthConfig> = {}) => createAuthenticator(config(over));

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

function roleEvent(userId: string, roles: UserRoleChangedPayload['roles']) {
  return createEnvelope({
    eventType: EVENTS.USER_ROLE_CHANGED,
    schemaVersion: 1,
    aggregateId: userId,
    producer: 'user-service',
    correlationId: randomUUID(),
    payload: {
      userId,
      roles,
      reasonRef: randomUUID(),
      occurredAt: new Date().toISOString(),
    } satisfies UserRoleChangedPayload,
  });
}

/**
 * Holds the User Service's introspection reply on the wire. `answered` resolves once the reply has
 * been produced (so it carries the status at that moment); nothing is returned to the client until
 * `release()`.
 */
function heldIntrospection() {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let arrived!: () => void;
  const answered = new Promise<void>((r) => (arrived = r));
  let holding = true;
  const fetchImpl: typeof fetch = async (url, init) => {
    const res = await fetch(url, init);
    if (holding && String(url).includes('/internal/introspect')) {
      arrived();
      await held;
    }
    return res;
  };
  return {
    fetch: fetchImpl,
    answered,
    release: () => {
      holding = false;
      release();
    },
  };
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

    handlerFor(auth).handle(statusEvent(alex.userId, 'SUSPENDED'));
    expect(await outcome(auth.authenticate(header))).toBe('ACCOUNT_SUSPENDED');
  });

  it('a reactivation lets the user straight back in', async () => {
    now = 0;
    const auth = make();
    const alex = await fake.login({ status: 'SUSPENDED' });
    const header = `Bearer ${alex.token}`;
    expect(await outcome(auth.authenticate(header))).toBe('ACCOUNT_SUSPENDED');

    fake.sessions.get(alex.sid)!.status = 'ACTIVE';
    handlerFor(auth).handle(statusEvent(alex.userId, 'ACTIVE'));
    expect(await outcome(auth.authenticate(header))).toBe('OK');
  });

  it('a revoked administrator role stops working on the next request', async () => {
    now = 0;
    const auth = make();
    const admin = await fake.login({ roles: ['STUDENT', 'ADMIN'] });
    const header = `Bearer ${admin.token}`;
    expect((await auth.authenticate(header)).isAdmin).toBe(true);

    fake.sessions.get(admin.sid)!.roles = ['STUDENT'];
    now = 100;
    expect((await auth.authenticate(header)).isAdmin).toBe(true); // the cached answer

    handlerFor(auth).handle(roleEvent(admin.userId, ['STUDENT']));
    const after = await auth.authenticate(header);
    expect(after.isAdmin).toBe(false);
    expect(await outcome(Promise.resolve().then(() => auth.requireAdmin(after)))).toBe('FORBIDDEN');
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

    handlerFor(auth).handle(statusEvent(phone.userId, 'SUSPENDED'));
    for (const t of [phone.token, laptopToken, other.token]) await auth.authenticate(`Bearer ${t}`);
    // Both of the user's sessions were re-checked; the bystander was served from cache.
    expect(fake.stats.introspectCalls - before).toBe(2);
  });

  it('matches the user whatever the case of the id in the event (a UUID is case-insensitive)', async () => {
    now = 0;
    const auth = make();
    const alex = await fake.login();
    const header = `Bearer ${alex.token}`;
    await auth.authenticate(header);

    fake.sessions.get(alex.sid)!.status = 'SUSPENDED';
    handlerFor(auth).handle(statusEvent(alex.userId.toUpperCase(), 'SUSPENDED'));
    expect(await outcome(auth.authenticate(header))).toBe('ACCOUNT_SUSPENDED');
  });

  it('never caches an answer that was in flight when the event arrived', async () => {
    now = 0;
    // The User Service answers ACTIVE, but the reply is held on the wire until after the event.
    const wire = heldIntrospection();
    const auth = make({ fetch: wire.fetch });
    const alex = await fake.login();
    const header = `Bearer ${alex.token}`;

    const inFlight = auth.authenticate(header);
    await wire.answered; // the ACTIVE answer has been produced
    fake.sessions.get(alex.sid)!.status = 'SUSPENDED';
    handlerFor(auth).handle(statusEvent(alex.userId, 'SUSPENDED'));
    wire.release();
    expect(await outcome(inFlight)).toBe('OK'); // that one request was already decided

    // ... but its stale answer was not cached, so the next request sees the suspension.
    expect(await outcome(auth.authenticate(header))).toBe('ACCOUNT_SUSPENDED');
  });

  it('still refuses to cache that answer when many other users are invalidated meanwhile', async () => {
    now = 0;
    // A tiny cache bound: invalidation bookkeeping must not be reset by volume.
    const wire = heldIntrospection();
    const auth = make({ fetch: wire.fetch, maxCacheEntries: 2 });
    const alex = await fake.login();
    const header = `Bearer ${alex.token}`;

    const inFlight = auth.authenticate(header);
    await wire.answered;
    fake.sessions.get(alex.sid)!.status = 'SUSPENDED';
    const handler = handlerFor(auth);
    handler.handle(statusEvent(alex.userId, 'SUSPENDED'));
    for (let i = 0; i < 20; i++) handler.handle(statusEvent(randomUUID(), 'SUSPENDED'));
    wire.release();
    expect(await outcome(inFlight)).toBe('OK');

    expect(await outcome(auth.authenticate(header))).toBe('ACCOUNT_SUSPENDED');
  });

  it('decides nothing from the event: a forged "reactivated" cannot let a suspended user in', async () => {
    now = 0;
    const auth = make();
    const mallory = await fake.login({ status: 'SUSPENDED' });
    const header = `Bearer ${mallory.token}`;
    expect(await outcome(auth.authenticate(header))).toBe('ACCOUNT_SUSPENDED'); // now cached
    const before = fake.stats.introspectCalls;

    handlerFor(auth).handle(statusEvent(mallory.userId, 'ACTIVE'));
    // The forged event cost exactly one lookup, and the User Service's answer still stands.
    expect(await outcome(auth.authenticate(header))).toBe('ACCOUNT_SUSPENDED');
    expect(fake.stats.introspectCalls - before).toBe(1);
    expect(await outcome(auth.authenticate(header))).toBe('ACCOUNT_SUSPENDED');
    expect(fake.stats.introspectCalls - before).toBe(1); // and that answer is cached again
  });

  it('is idempotent: a duplicate costs nothing more, and an unknown user disturbs nobody', async () => {
    now = 0;
    const auth = make();
    const handler = handlerFor(auth);
    const alex = await fake.login();
    const bystander = await fake.login();
    await auth.authenticate(`Bearer ${alex.token}`);
    await auth.authenticate(`Bearer ${bystander.token}`);
    const before = fake.stats.introspectCalls;

    const event = statusEvent(alex.userId, 'SUSPENDED');
    handler.handle(event);
    handler.handle(event);
    handler.handle(statusEvent(randomUUID(), 'SUSPENDED')); // nobody cached
    await auth.authenticate(`Bearer ${alex.token}`);
    await auth.authenticate(`Bearer ${alex.token}`);
    await auth.authenticate(`Bearer ${bystander.token}`);
    // One re-check for alex, however many copies arrived; none for the bystander.
    expect(fake.stats.introspectCalls - before).toBe(1);
  });
});

describe('authStatusEvents', () => {
  it('gives every instance its own private, bounded queue bound to every identity change', () => {
    const order = authStatusEvents('order', { cacheTtlMs: 5_000 });
    const replica = authStatusEvents('order');
    expect(order.subscription).toEqual({
      queue: expect.stringMatching(/^foc\.order\.auth-status\.[0-9a-f-]{36}$/),
      routingKeys: [EVENTS.USER_SUSPENDED, EVENTS.USER_REACTIVATED, EVENTS.USER_ROLE_CHANGED],
      exclusive: true,
      autoDelete: true,
      messageTtlMs: 5_000,
      maxLength: expect.any(Number),
    });
    // Replicas of one service must not compete for one queue: each holds its own cache.
    expect(replica.subscription.queue).not.toBe(order.subscription.queue);
    expect(order.providers).toContain(UserStatusInvalidation);
  });

  it('keeps an invalidation only as long as a stale answer could still be cached', () => {
    expect(authStatusEvents('credit', { cacheTtlMs: 8_000 }).subscription.messageTtlMs).toBe(8_000);
    expect(authStatusEvents('credit').subscription.messageTtlMs).toBe(5_000); // the default window
  });

  it('subscribes its own queue at bootstrap, and the handler invalidates', async () => {
    now = 0;
    const status = authStatusEvents('order', config());
    const subscribed: Array<SubscribeOptions<{ userId: string }>> = [];
    const consumer = {
      subscribe: async (options: SubscribeOptions<{ userId: string }>) => {
        subscribed.push(options);
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule.forRoot(config())],
      providers: [{ provide: EVENT_CONSUMER, useValue: consumer }, ...status.providers],
    }).compile();
    await moduleRef.init();
    try {
      expect(subscribed).toHaveLength(1);
      const [options] = subscribed as [SubscribeOptions<{ userId: string }>];
      expect(options.queue).toBe(status.subscription.queue);
      // It accepts both payload shapes the queue is bound to, and nothing else.
      const schema = options.payloadSchema;
      expect(schema.safeParse(statusEvent(randomUUID(), 'SUSPENDED').payload).success).toBe(true);
      expect(schema.safeParse(roleEvent(randomUUID(), ['STUDENT']).payload).success).toBe(true);
      expect(schema.safeParse({ userId: 'u-1' }).success).toBe(false);

      // The subscribed handler drives the module's own authenticator.
      const auth = moduleRef.get<Authenticator>(AUTHENTICATOR);
      const alex = await fake.login();
      const header = `Bearer ${alex.token}`;
      await auth.authenticate(header);
      fake.sessions.get(alex.sid)!.status = 'SUSPENDED';
      await options.handler(statusEvent(alex.userId, 'SUSPENDED'), {
        attempt: 1,
        queue: options.queue,
      });
      expect(await outcome(auth.authenticate(header))).toBe('ACCOUNT_SUSPENDED');
    } finally {
      await moduleRef.close();
    }
  });
});
