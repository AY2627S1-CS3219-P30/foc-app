import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EVENTS } from './catalogue.js';
import type { BrokerConnection } from './connection.js';
import { EventValidationError, UnroutableEventError, type Envelope } from './envelope.js';
import { EventPublisher } from './publisher.js';
import { EXCHANGE } from './topology.js';

/**
 * A confirm channel that records what reached it, and how often it was asked for. `unbound` names
 * routing keys no queue is bound to: a mandatory message for one is handed back, then confirmed,
 * as RabbitMQ does.
 */
function fakeBroker(unbound: string[] = []) {
  const sent: Array<{
    exchange: string;
    routingKey: string;
    envelope: Envelope;
    mandatory: boolean;
  }> = [];
  let channelsTaken = 0;
  let confirmError: Error | null = null;
  const returnListeners: Array<(message: { properties: { messageId?: string } }) => void> = [];
  const channel = {
    on(event: string, listener: (message: { properties: { messageId?: string } }) => void) {
      if (event === 'return') returnListeners.push(listener);
    },
    publish(
      exchange: string,
      routingKey: string,
      body: Buffer,
      options: { mandatory?: boolean; messageId?: string },
      done: (err: Error | null) => void,
    ) {
      const mandatory = options.mandatory === true;
      sent.push({
        exchange,
        routingKey,
        envelope: JSON.parse(body.toString('utf8')) as Envelope,
        mandatory,
      });
      if (mandatory && unbound.includes(routingKey)) {
        for (const listener of returnListeners) {
          listener({ properties: { messageId: options.messageId } });
        }
      }
      const err = confirmError;
      confirmError = null;
      done(err);
      return true;
    },
  };
  const broker = {
    getChannel: () => {
      channelsTaken += 1;
      return channel;
    },
  } as unknown as BrokerConnection;
  return {
    broker,
    sent,
    channelsTaken: () => channelsTaken,
    /** The next publish ends as amqplib ends a pending confirm when its channel closes. */
    closeBeforeConfirm: () => {
      confirmError = new Error('channel closed');
    },
  };
}

const activation = {
  eventType: EVENTS.USER_ACTIVATED,
  schemaVersion: 1,
  aggregateId: 'user-1',
  correlationId: 'trace-1',
  payload: { userId: 'user-1', activatedAt: '2026-10-13T08:00:00.000Z' },
};

beforeAll(() => Logger.overrideLogger(false));

describe('validating on send (EVT-03)', () => {
  it('publishes a valid event under its type', async () => {
    const { broker, sent } = fakeBroker();
    const envelope = await new EventPublisher(broker, 'user-service').publish(activation);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ exchange: EXCHANGE, routingKey: EVENTS.USER_ACTIVATED });
    expect(sent[0]!.envelope).toEqual(envelope);
    expect(envelope).toMatchObject({ producer: 'user-service', payload: activation.payload });
  });

  it('refuses a payload that fails its schema and publishes nothing', async () => {
    const { broker, sent, channelsTaken } = fakeBroker();
    const publisher = new EventPublisher(broker, 'user-service');

    const refused = publisher.publish({ ...activation, payload: { userId: '' } });

    await expect(refused).rejects.toBeInstanceOf(EventValidationError);
    await expect(refused).rejects.toThrow(/^payload invalid: userId /);
    expect(sent).toEqual([]);
    expect(channelsTaken()).toBe(0);
  });

  it('refuses an event type the catalogue does not know', async () => {
    const { broker, sent } = fakeBroker();
    const publisher = new EventPublisher(broker, 'user-service');

    const refused = publisher.publish({ ...activation, eventType: 'user.made-up' });

    await expect(refused).rejects.toBeInstanceOf(EventValidationError);
    await expect(refused).rejects.toThrow('unknown event type user.made-up: not in the catalogue');
    expect(sent).toEqual([]);
  });

  it('checks against the schemas it was given, for a suite with event types of its own', async () => {
    const { broker, sent } = fakeBroker();
    const publisher = new EventPublisher(broker, 'test', {
      schemas: { 'test.ping': z.object({ n: z.number() }) },
    });

    await publisher.publish({ ...activation, eventType: 'test.ping', payload: { n: 1 } });
    await expect(
      publisher.publish({ ...activation, eventType: 'test.ping', payload: { n: 'one' } }),
    ).rejects.toBeInstanceOf(EventValidationError);
    // The catalogue is replaced, not extended: a real event is unknown to this publisher.
    await expect(publisher.publish(activation)).rejects.toBeInstanceOf(EventValidationError);
    expect(sent.map((s) => s.routingKey)).toEqual(['test.ping']);
  });
});

describe('an event nobody is listening for (EI-NFR1)', () => {
  const statusChange = {
    eventType: EVENTS.ORDER_STATUS_CHANGED,
    schemaVersion: 1,
    aggregateId: '00000000-0000-4000-8000-000000000129',
    correlationId: 'trace-1',
    payload: {
      orderId: '00000000-0000-4000-8000-000000000129',
      previousStatus: null,
      newStatus: 'PENDING_CREDIT',
      occurredAt: '2026-10-13T08:00:00.000Z',
    },
  };

  it('refuses to lose an event that needs a consumer when no queue is bound for it', async () => {
    // A clean broker on which the Credit Service has never started.
    const { broker, sent } = fakeBroker([EVENTS.USER_ACTIVATED]);
    const publisher = new EventPublisher(broker, 'user-service');

    const lost = publisher.publish(activation);

    await expect(lost).rejects.toBeInstanceOf(UnroutableEventError);
    await expect(lost).rejects.toThrow('unroutable: no queue is bound for user.activated');
    expect(sent[0]!.mandatory).toBe(true);
  });

  it('publishes it once a queue is bound', async () => {
    const unbound = [EVENTS.USER_ACTIVATED];
    const { broker } = fakeBroker(unbound);
    const publisher = new EventPublisher(broker, 'user-service');
    await expect(publisher.publish(activation)).rejects.toBeInstanceOf(UnroutableEventError);

    unbound.length = 0; // the Credit Service has started and declared its queue
    await expect(publisher.publish(activation)).resolves.toMatchObject({
      eventType: EVENTS.USER_ACTIVATED,
    });
  });

  it('does not hold a hand-back against the next attempt when the channel closed before the confirmation', async () => {
    const unbound = [EVENTS.USER_ACTIVATED];
    const fake = fakeBroker(unbound);
    const publisher = new EventPublisher(fake.broker, 'user-service');
    // The outbox relay sends every attempt at a row under the row's own id.
    const attempt = { ...activation, eventId: '00000000-0000-4000-8000-000000000153' };

    fake.closeBeforeConfirm();
    await expect(publisher.publish(attempt)).rejects.toThrow('channel closed');

    unbound.length = 0; // the Credit Service has started and declared its queue
    await expect(publisher.publish(attempt)).resolves.toMatchObject({ eventId: attempt.eventId });
  });

  it('fails only the event that was handed back, not one sent beside it', async () => {
    const { broker } = fakeBroker([EVENTS.USER_ACTIVATED]);
    const publisher = new EventPublisher(broker, 'credit-service');
    const routed = {
      ...activation,
      eventType: EVENTS.CREDITS_RESERVED,
      payload: { orderId: 'order-1', requesterId: 'user-1', amount: 3 },
    };

    const [first, second] = await Promise.allSettled([
      publisher.publish(activation),
      publisher.publish(routed),
    ]);

    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
  });

  it('lets a fact that may have no listener go, bound or not', async () => {
    const { broker, sent } = fakeBroker([EVENTS.ORDER_STATUS_CHANGED]);
    const publisher = new EventPublisher(broker, 'order-service');

    await expect(publisher.publish(statusChange)).resolves.toBeDefined();
    expect(sent[0]!.mandatory).toBe(false);
  });

  it('takes the events that need a consumer from the caller, for a suite with types of its own', async () => {
    const { broker } = fakeBroker(['test.ping']);
    const publisher = new EventPublisher(broker, 'test', {
      schemas: { 'test.ping': z.object({ n: z.number() }) },
      requiresConsumer: new Set(['test.ping']),
    });

    await expect(
      publisher.publish({ ...activation, eventType: 'test.ping', payload: { n: 1 } }),
    ).rejects.toBeInstanceOf(UnroutableEventError);
  });
});
