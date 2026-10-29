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
  const schemas = new Map<string, { safeParse(value: unknown): { success: boolean } }>();

  beforeAll(async () => {
    vi.stubEnv('RABBITMQ_URL', 'amqp://broker.test');
    // Imported after the variable is set: the module reads its configuration at load time.
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const { LifecycleScheduler } = await import('../src/orders/lifecycle.scheduler.js');
    // There is no database here; the scheduler has its own tests.
    vi.spyOn(moduleRef.get(LifecycleScheduler), 'onApplicationBootstrap').mockReturnValue();
    broker = moduleRef.get<BrokerConnection>(BROKER);
    vi.spyOn(broker, 'connect').mockResolvedValue();
    const consumer = moduleRef.get<EventConsumer>(EVENT_CONSUMER);
    const subscribe = consumer.subscribe.bind(consumer);
    vi.spyOn(consumer, 'subscribe').mockImplementation((options) => {
      subscribed.push(options.queue);
      schemas.set(options.queue, options.payloadSchema);
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
    const queue = subscribed.find((q) => q.startsWith('foc.order.auth-status.'));
    expect(queue, `subscribed: ${subscribed.join(', ')}`).toBeDefined();

    // ... and that queue is declared, private to this instance, bound to every key.
    expect(broker.subscription(queue!)).toMatchObject({
      routingKeys: [...IDENTITY_CHANGE_EVENTS],
      exclusive: true,
      messageTtlMs: expect.any(Number),
      maxLength: expect.any(Number),
    });
  });

  it('subscribes and declares the Credit reply queues, each bound only to its own result', () => {
    for (const [queue, routingKey] of [
      ['foc.order.reservation-results', 'credit.reserved'],
      ['foc.order.transfer-results', 'credit.transferred'],
      ['foc.order.release-results', 'credit.released'],
    ] as const) {
      expect(subscribed).toContain(queue);
      expect(broker.subscription(queue)?.routingKeys).toContain(routingKey);
    }
  });

  it('subscribes a durable queue of its own to suspensions, shared by every instance (ORD-06)', () => {
    expect(subscribed).toContain('foc.order.user-suspensions');
    expect(broker.subscription('foc.order.user-suspensions')).toMatchObject({
      routingKeys: ['user.suspended'],
    });
    expect(broker.subscription('foc.order.user-suspensions')?.exclusive).not.toBe(true);
  });

  it('subscribes a queue of its own to every errand status change, for its live streams (N1.4)', () => {
    const queue = subscribed.find((q) => q.startsWith('foc.order.live.'));
    expect(queue, `subscribed: ${subscribed.join(', ')}`).toBeDefined();

    // Private to this instance and holding nothing durable, so the event's delivery is unchanged.
    expect(broker.subscription(queue!)).toMatchObject({
      routingKeys: ['order.status-changed'],
      metricsLabel: 'foc.order.live',
      exclusive: true,
      autoDelete: true,
      messageTtlMs: 30_000,
      maxLength: 1_000,
    });
    // ... and its handler is given the status change's schema, so a change parses.
    const parsed = schemas.get(queue!)?.safeParse({
      orderId: '00000000-0000-4000-8000-000000000129',
      previousStatus: 'OPEN',
      newStatus: 'ACCEPTED',
      occurredAt: new Date().toISOString(),
      orderVersion: 3,
    });
    expect(parsed?.success).toBe(true);
  });
});
