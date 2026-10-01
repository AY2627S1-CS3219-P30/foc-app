import { afterEach, describe, expect, it } from 'vitest';
import {
  EVENTS,
  UnparseableMessageError,
  createEnvelope,
  type EventConsumer,
  type SubscribeOptions,
} from '@foc/platform';
import {
  COMPLETION_QUEUE,
  RELEASE_QUEUE,
  CompletionConsumer,
  ReleaseConsumer,
} from '../src/terminal-consumers.js';
import { createTestApp, issue, type TestApp } from './helpers/app.js';

class RecordingConsumer {
  readonly subscriptions: SubscribeOptions<unknown>[] = [];

  async subscribe<T>(options: SubscribeOptions<T>): Promise<void> {
    this.subscriptions.push(options as SubscribeOptions<unknown>);
  }
}

describe('terminal event consumers', () => {
  let testApp: TestApp | undefined;
  afterEach(async () => testApp?.close());

  it('trusts only Order and rejects malformed terminal payloads at the subscription boundary', async () => {
    testApp = await createTestApp();
    const recorder = new RecordingConsumer();
    await new CompletionConsumer(
      recorder as unknown as EventConsumer,
      testApp.db,
      testApp.credits,
    ).onApplicationBootstrap();
    await new ReleaseConsumer(
      recorder as unknown as EventConsumer,
      testApp.db,
      testApp.credits,
    ).onApplicationBootstrap();

    expect(recorder.subscriptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          queue: COMPLETION_QUEUE,
          eventType: EVENTS.ORDER_COMPLETION_REQUESTED,
          expectedProducer: 'order-service',
        }),
        expect.objectContaining({
          queue: RELEASE_QUEUE,
          eventType: EVENTS.CREDIT_RELEASE_REQUESTED,
          expectedProducer: 'order-service',
        }),
      ]),
    );
    for (const subscription of recorder.subscriptions) {
      expect(subscription.payloadSchema.safeParse({ orderId: 'order-1', amount: 1 }).success).toBe(
        false,
      );
    }
  });

  it('replays an identical completion envelope to reproduce a lost confirmation', async () => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    await issue(testApp, 'courier-1');
    await testApp.db.transaction((tx) =>
      testApp!.credits.reserve(tx, {
        orderId: 'order-1',
        requesterId: 'student-1',
        amount: 3,
        correlationId: 'corr-1',
        causationId: 'reservation-1',
      }),
    );

    const recorder = new RecordingConsumer();
    await new CompletionConsumer(
      recorder as unknown as EventConsumer,
      testApp.db,
      testApp.credits,
    ).onApplicationBootstrap();
    const subscription = recorder.subscriptions[0]!;
    const envelope = createEnvelope({
      eventId: '1c56b2d9-bbba-4c0d-b59a-0054215223d0',
      eventType: EVENTS.ORDER_COMPLETION_REQUESTED,
      schemaVersion: 1,
      aggregateId: 'order-1',
      producer: 'order-service',
      correlationId: 'corr-1',
      payload: {
        orderId: 'order-1',
        requesterId: 'student-1',
        courierId: 'courier-1',
        amount: 3,
      },
    });

    await subscription.handler(envelope, { attempt: 1, queue: COMPLETION_QUEUE });
    await subscription.handler(envelope, { attempt: 2, queue: COMPLETION_QUEUE });

    expect(
      (
        await testApp.db.query(
          `SELECT * FROM processed_events WHERE consumer = $1 AND event_id = $2`,
          [COMPLETION_QUEUE, envelope.eventId],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await testApp.db.query(
          `SELECT * FROM credit_transactions WHERE transaction_type = 'TRANSFER'`,
        )
      ).rows,
    ).toHaveLength(1);
    const replies = await testApp.db.query<{ payload: unknown } & Record<string, unknown>>(
      `SELECT payload FROM outbox_events WHERE event_type = 'credit.transferred' ORDER BY seq`,
    );
    expect(replies.rows).toHaveLength(2);
    expect(replies.rows[1]!.payload).toEqual(replies.rows[0]!.payload);
  });

  it('dead-letters an aggregate mismatch without committing an inbox record', async () => {
    testApp = await createTestApp();
    const recorder = new RecordingConsumer();
    await new ReleaseConsumer(
      recorder as unknown as EventConsumer,
      testApp.db,
      testApp.credits,
    ).onApplicationBootstrap();
    const envelope = createEnvelope({
      eventType: EVENTS.CREDIT_RELEASE_REQUESTED,
      schemaVersion: 1,
      aggregateId: 'different-order',
      producer: 'order-service',
      correlationId: 'corr-1',
      payload: { orderId: 'order-1', requesterId: 'student-1', amount: 3 },
    });

    await expect(
      recorder.subscriptions[0]!.handler(envelope, { attempt: 1, queue: RELEASE_QUEUE }),
    ).rejects.toBeInstanceOf(UnparseableMessageError);
    expect((await testApp.db.query(`SELECT * FROM processed_events`)).rows).toHaveLength(0);
  });
});
