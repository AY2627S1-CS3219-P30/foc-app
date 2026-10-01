import {
  UnparseableMessageError,
  type Envelope,
  type EventConsumer,
  type SubscribeOptions,
} from '@foc/platform';

/** What the bus does to one delivery; the default is to deliver it once. */
export type Fault = 'deliver' | 'drop' | 'duplicate';

export interface Delivery {
  envelope: Envelope<unknown>;
  queue: string;
  outcome: 'handled' | 'dead-lettered' | 'dropped';
  error?: string;
}

/**
 * An in-memory broker with the same contract the services get from RabbitMQ: each subscription
 * receives every event of its types, the declared producer and catalogue payload are enforced
 * before the handler runs, and an unparseable message is dead-lettered rather than retried.
 * Faults can drop or duplicate any delivery, standing in for lost and redelivered messages.
 */
export class InMemoryBus {
  readonly subscriptions: SubscribeOptions<unknown>[] = [];
  readonly deliveries: Delivery[] = [];
  readonly pending: Envelope<unknown>[] = [];
  retries = 0;
  fault: (envelope: Envelope<unknown>, queue: string) => Fault = () => 'deliver';
  /** Attempts per delivery before a transient failure is dead-lettered, as the broker does. */
  maxAttempts = 5;

  /** The EventConsumer each service's consumers subscribe through. */
  readonly consumer = {
    subscribe: async <T>(options: SubscribeOptions<T>) => {
      this.subscriptions.push(options as SubscribeOptions<unknown>);
    },
  } as unknown as EventConsumer;

  publish(envelope: Envelope<unknown>): void {
    this.pending.push(envelope);
  }

  /** Delivers everything queued so far; returns how many deliveries ran. */
  async drain(): Promise<number> {
    let count = 0;
    while (this.pending.length > 0) {
      const envelope = this.pending.shift()!;
      for (const sub of this.subscriptions) {
        const types = Array.isArray(sub.eventType) ? sub.eventType : [sub.eventType];
        if (!types.includes(envelope.eventType)) continue;
        const fault = this.fault(envelope, sub.queue);
        if (fault === 'drop') {
          this.deliveries.push({ envelope, queue: sub.queue, outcome: 'dropped' });
          continue;
        }
        for (let copy = 0; copy < (fault === 'duplicate' ? 2 : 1); copy++) {
          count += 1;
          await this.deliver(sub, envelope);
        }
      }
    }
    return count;
  }

  private async deliver(
    sub: SubscribeOptions<unknown>,
    envelope: Envelope<unknown>,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        if (sub.expectedProducer && envelope.producer !== sub.expectedProducer) {
          throw new UnparseableMessageError(`producer ${envelope.producer} is not trusted`);
        }
        const parsed = sub.payloadSchema.safeParse(envelope.payload);
        if (!parsed.success) {
          throw new UnparseableMessageError('payload does not match the catalogue');
        }
        await sub.handler({ ...envelope, payload: parsed.data }, { attempt, queue: sub.queue });
        this.deliveries.push({ envelope, queue: sub.queue, outcome: 'handled' });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Unparseable messages are dead-lettered at once; anything else is retried with the
        // same envelope, as the broker's retry queues do, until the attempts run out.
        if (error instanceof UnparseableMessageError || attempt >= this.maxAttempts) {
          this.deliveries.push({
            envelope,
            queue: sub.queue,
            outcome: 'dead-lettered',
            error: message,
          });
          if (error instanceof UnparseableMessageError) return;
          throw error;
        }
        this.retries += 1;
      }
    }
  }
}
