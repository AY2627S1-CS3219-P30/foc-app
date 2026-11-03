import type { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUTHENTICATOR, IDENTITY_CHANGE_EVENTS, type Authenticator } from '@foc/auth-client';
import {
  BROKER,
  createEnvelope,
  EVENT_CONSUMER,
  type BrokerConnection,
  type EventConsumer,
  type EventHandler,
} from '@foc/platform';
import { SocketHub } from '../src/chat/socket/socket-hub.js';

/**
 * USR-07: with a broker configured, this service must drop a user's cached identity when their
 * status or roles change. Boots the real AppModule with RABBITMQ_URL set; only the connection is
 * stubbed, so nothing reaches a broker and the subscription is simply recorded.
 */
describe('identity-change invalidation is wired (USR-07)', () => {
  let app: INestApplication;
  let broker: BrokerConnection;
  const subscribed: string[] = [];
  const handlers = new Map<string, EventHandler<unknown>>();
  const invalidated: string[] = [];
  /** Takes the token as the user's ID; nothing here reaches the User Service. */
  const authenticator: Authenticator = {
    authenticate: async (header) => ({
      userId: header!.replace('Bearer ', ''),
      sessionId: 'session',
      displayName: 'Someone',
      roles: ['STUDENT'],
      status: 'ACTIVE',
      isAdmin: false,
    }),
    requireAdmin: () => undefined,
    invalidateUser: (userId) => void invalidated.push(userId),
  };

  beforeAll(async () => {
    vi.stubEnv('RABBITMQ_URL', 'amqp://broker.test');
    // Imported after the variable is set: the module reads its configuration at load time.
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AUTHENTICATOR)
      .useValue(authenticator)
      .compile();
    broker = moduleRef.get<BrokerConnection>(BROKER);
    vi.spyOn(broker, 'connect').mockResolvedValue();
    const consumer = moduleRef.get<EventConsumer>(EVENT_CONSUMER);
    const subscribe = consumer.subscribe.bind(consumer);
    vi.spyOn(consumer, 'subscribe').mockImplementation((options) => {
      subscribed.push(options.queue);
      handlers.set(options.queue, options.handler);
      return subscribe(options);
    });
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('subscribes, at bootstrap, a queue of its own to every identity change', () => {
    const queue = subscribed.find((q) => q.startsWith('foc.chat.auth-status.'));
    expect(queue, `subscribed: ${subscribed.join(', ')}`).toBeDefined();

    // ... and that queue is declared, private to this instance, bound to every key.
    expect(broker.subscription(queue!)).toMatchObject({
      routingKeys: [...IDENTITY_CHANGE_EVENTS],
      exclusive: true,
      messageTtlMs: expect.any(Number),
      maxLength: expect.any(Number),
    });
  });

  it('subscribes a second queue of its own, which closes that user’s chat sockets (#346)', () => {
    const queue = subscribed.find((q) => q.startsWith('foc.chat.socket-status.'));
    expect(queue, `subscribed: ${subscribed.join(', ')}`).toBeDefined();
    expect(broker.subscription(queue!)).toMatchObject({
      routingKeys: [...IDENTITY_CHANGE_EVENTS],
      exclusive: true,
      autoDelete: true,
      messageTtlMs: expect.any(Number),
      maxLength: expect.any(Number),
    });
    // The chat-service broker account may use only `foc.chat.*` and `foc.chat-service.*` names.
    expect(queue).toMatch(/^foc\.chat(-service)?\..*$/);
  });

  it('closes every chat socket of a user whose identity changed, delivered on that queue', async () => {
    const queue = subscribed.find((q) => q.startsWith('foc.chat.socket-status.'))!;
    const hub = app.get(SocketHub);
    const close = vi.fn();
    const socket = hub.connect({ send: vi.fn(), close, ping: vi.fn(), terminate: vi.fn() });
    await hub.received(socket, { type: 'auth', token: 'user-1' });
    invalidated.length = 0;

    await handlers.get(queue)!(
      createEnvelope({
        eventType: 'user.suspended',
        schemaVersion: 1,
        aggregateId: 'user-1',
        producer: 'user-service',
        correlationId: 'correlation-1',
        payload: { userId: 'user-1', status: 'SUSPENDED' },
      }),
      { attempt: 1, queue },
    );

    expect(close).toHaveBeenCalledWith(4401, expect.any(String));
    // Forgotten too, so the reconnect is checked against the User Service, not the cache.
    expect(invalidated).toContain('user-1');
  });
});
