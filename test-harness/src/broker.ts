import { randomBytes } from 'node:crypto';
import amqp from 'amqplib';
import {
  deadLetterQueueName,
  retryExchangeName,
  retryQueueName,
  RETRY_DELAYS_MS,
} from '@foc/platform';

/** Unset means the broker suites skip themselves, so `npm test` passes on a clean clone. */
export const RABBITMQ_URL = process.env.RABBITMQ_URL;

export interface EphemeralBroker {
  readonly url: string;
  /** A per-run namespace for `BrokerConnection`, which scopes its retry exchanges and queues. */
  readonly namespace: string;
  /** A per-run queue name. Every queue created through this is deleted by `dispose`. */
  queue(name: string): string;
  /** Deletes this run's queues, their dead-letter queues and the namespace's retry topology. */
  dispose(): Promise<void>;
}

/**
 * Isolates one test run on a shared broker. The `foc.events` topic exchange is shared by design
 * (it is the production topology under test), so isolation comes from unique queue names and a
 * unique retry namespace. Tests must still assert on their own aggregate or correlation IDs,
 * because a concurrent run binding the same routing key also receives a copy of each message.
 */
export function createEphemeralBroker(url: string, label = 'run'): EphemeralBroker {
  const run = `${label.replace(/[^a-z0-9-]/gi, '-')}-${randomBytes(3).toString('hex')}`;
  const namespace = `test-${run}`;
  const queues = new Set<string>();
  return {
    url,
    namespace,
    queue(name) {
      const queue = `foc.test-${run}.${name}`;
      queues.add(queue);
      return queue;
    },
    async dispose() {
      // A throwaway connection: deleting a queue that still has a consumer on the
      // caller's channel cancels that consumer, so callers close theirs first.
      const conn = await amqp.connect(url);
      try {
        const ch = await conn.createChannel();
        for (const queue of queues) {
          await ch.deleteQueue(queue);
          await ch.deleteQueue(deadLetterQueueName(queue));
        }
        for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
          await ch.deleteQueue(retryQueueName(namespace, attempt));
          await ch.deleteExchange(retryExchangeName(namespace, attempt));
        }
      } finally {
        await conn.close();
      }
    },
  };
}
