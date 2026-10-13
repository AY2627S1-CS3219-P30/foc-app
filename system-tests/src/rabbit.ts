import {
  BrokerConnection,
  EventConsumer,
  EventPublisher,
  OutboxRelay,
  type Envelope,
} from '@foc/platform';
import { createEphemeralBroker, type EphemeralBroker } from '@foc/test-harness';
import type { Stack } from './stack.js';

const quiet = { log() {}, warn() {}, error() {} };

/**
 * Runs a started {@link Stack} over a real RabbitMQ instead of the in-memory bus: the same
 * consumers, subscribed through the platform EventConsumer on run-scoped queues bound to the
 * production `foc.events` exchange, and the same outbox relays publishing through the platform
 * EventPublisher. With `replay`, every event is published twice under its one event ID — the
 * at-least-once delivery the inboxes exist for.
 */
export class RabbitWiring {
  readonly published: Envelope<unknown>[] = [];
  private inFlight = 0;
  private connection!: BrokerConnection;
  private relays: OutboxRelay[] = [];

  private constructor(
    private readonly stack: Stack,
    private readonly broker: EphemeralBroker,
    private readonly replay: boolean,
  ) {}

  static async start(
    stack: Stack,
    url: string,
    options: { replay: boolean },
  ): Promise<RabbitWiring> {
    const wiring = new RabbitWiring(stack, createEphemeralBroker(url, 'system'), options.replay);
    await wiring.connect();
    return wiring;
  }

  private async connect(): Promise<void> {
    const subs = this.stack.bus.subscriptions;
    this.connection = new BrokerConnection(
      this.broker.url,
      this.broker.namespace,
      subs.map((sub) => ({
        queue: this.broker.queue(sub.queue),
        routingKeys: Array.isArray(sub.eventType) ? [...sub.eventType] : [sub.eventType as string],
      })),
      // Short retry delays: the production backoff is seconds; the path is identical.
      [50, 50, 50, 50],
    );
    await this.connection.connect();
    const consumer = new EventConsumer(this.connection);
    for (const sub of subs) {
      await consumer.subscribe({
        ...sub,
        queue: this.broker.queue(sub.queue),
        handler: async (envelope, context) => {
          this.inFlight += 1;
          try {
            await sub.handler(envelope, context);
          } finally {
            this.inFlight -= 1;
          }
        },
      });
    }
    this.relays = [
      this.relay(this.stack.orderDb.db, 'order-service'),
      this.relay(this.stack.creditDb.db, 'credit-service'),
    ];
  }

  private relay(db: import('@foc/platform').Db, producer: string): OutboxRelay {
    const publisher = new EventPublisher(this.connection, producer);
    return new OutboxRelay({
      db,
      logger: quiet,
      publisher: {
        publish: async (input) => {
          const envelope = await publisher.publish(input);
          this.published.push(envelope as Envelope<unknown>);
          if (this.replay) await publisher.publish(input);
          return envelope;
        },
      },
    });
  }

  /** Publishes events that were already delivered again, as a broker replay would. */
  async republish(envelopes: Envelope<unknown>[]): Promise<void> {
    for (const envelope of envelopes) {
      const { producer, eventId, occurredAt: _occurredAt, ...rest } = envelope;
      await new EventPublisher(this.connection, producer).publish({ ...rest, eventId } as never);
    }
  }

  private async queuesEmpty(): Promise<boolean> {
    const channel = this.connection.getChannel();
    for (const sub of this.stack.bus.subscriptions) {
      const { messageCount } = await channel.checkQueue(this.broker.queue(sub.queue));
      if (messageCount > 0) return false;
    }
    return true;
  }

  private async unpublished(): Promise<number> {
    let total = 0;
    for (const db of [this.stack.orderDb.db, this.stack.creditDb.db]) {
      const result = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM outbox_events WHERE published_at IS NULL`,
      );
      total += Number(result.rows[0]!.n);
    }
    return total;
  }

  /** Relays and waits until nothing is unpublished, queued, or being handled, for a quiet moment. */
  async settle(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let quietSince = 0;
    while (Date.now() < deadline) {
      for (const relay of this.relays) await relay.tick().catch(() => 0);
      const idle =
        this.inFlight === 0 && (await this.unpublished()) === 0 && (await this.queuesEmpty());
      if (idle) {
        if (quietSince === 0) quietSince = Date.now();
        // Longer than the retry delays, so a message waiting in a retry queue is not missed.
        if (Date.now() - quietSince > 400) return;
      } else {
        quietSince = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the broker did not settle');
  }

  async stop(): Promise<void> {
    await this.connection.close();
    await this.broker.dispose();
  }
}
