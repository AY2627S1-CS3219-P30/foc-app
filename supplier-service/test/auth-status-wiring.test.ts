import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IDENTITY_CHANGE_EVENTS } from '@foc/auth-client';
import { BROKER, EVENT_CONSUMER, type BrokerConnection, type EventConsumer } from '@foc/platform';

/**
 * USR-07: with a broker configured, this service must drop a user's cached identity when their
 * status or roles change. Boots the real AppModule with RABBITMQ_URL set; only the connection is
 * stubbed, so nothing reaches a broker and the subscription is simply recorded.
 */
describe('identity-change invalidation is wired (USR-07)', () => {
  let app: INestApplication;
  let broker: BrokerConnection;
  const subscribed: string[] = [];

  beforeAll(async () => {
    vi.stubEnv('RABBITMQ_URL', 'amqp://broker.test');
    // Imported after the variable is set: the module reads its configuration at load time.
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    broker = moduleRef.get<BrokerConnection>(BROKER);
    vi.spyOn(broker, 'connect').mockResolvedValue();
    const consumer = moduleRef.get<EventConsumer>(EVENT_CONSUMER);
    const subscribe = consumer.subscribe.bind(consumer);
    vi.spyOn(consumer, 'subscribe').mockImplementation((options) => {
      subscribed.push(options.queue);
      return subscribe(options);
    });
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('subscribes, at bootstrap, a queue of its own to every identity change', () => {
    const queue = subscribed.find((q) => q.startsWith('foc.supplier.auth-status.'));
    expect(queue, `subscribed: ${subscribed.join(', ')}`).toBeDefined();

    // ... and that queue is declared, private to this instance, bound to every key.
    expect(broker.subscription(queue!)).toMatchObject({
      routingKeys: [...IDENTITY_CHANGE_EVENTS],
      exclusive: true,
      messageTtlMs: expect.any(Number),
      maxLength: expect.any(Number),
    });
  });
});
