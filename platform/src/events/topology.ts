/**
 * The broker layout, declared as data so it can be asserted in a test and
 * recreated from an empty broker (an acceptance criterion of EVT-01).
 *
 * Retry uses the standard RabbitMQ delayed-retry pattern rather than an
 * immediate requeue: a nack-and-requeue loop spins hot and starves everything
 * else. A failed message is published to a retry queue that holds it for a TTL
 * and then dead-letters it back onto the main exchange. Each attempt waits
 * longer. After the last attempt it goes to the consuming queue's dead-letter
 * queue with the reason attached (EI-FR2.1.2).
 *
 * Each delay level has its own **fanout** exchange, and its queue dead-letters
 * onto the **default** exchange. A failed message is published into the retry
 * exchange with the name of the queue it failed on as its routing key: fanout
 * ignores the key on the way in and preserves it on the way out, and the
 * default exchange routes by queue name. So a retry goes back to that one queue
 * only — never to every other queue bound to the same event type, which would
 * make another service handle the event twice.
 */

export const EXCHANGE = 'foc.events';
export const DLX = 'foc.events.dlx';

/** Header names carried alongside the envelope, for the broker's own bookkeeping. */
export const HEADER_ATTEMPT = 'x-foc-attempt';
export const HEADER_FAILURE = 'x-foc-failure-reason';
export const HEADER_ORIGINAL_QUEUE = 'x-foc-original-queue';

/**
 * Backoff per attempt, in milliseconds. Five attempts totalling about 81
 * seconds, comfortably inside the five-minute bound in EI-NFR1.1.2.
 */
export const RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export interface SubscriptionSpec {
  /** Queue name, conventionally `foc.<service>.<purpose>`. */
  queue: string;
  /** Routing keys this queue binds to on the main exchange. */
  routingKeys: string[];
  /**
   * Private to this instance: only its own connection may consume it, and the
   * broker deletes it when that connection closes (it is declared again on every
   * reconnect). For messages every replica must see — dropping a cache entry —
   * rather than one replica per message. The name must be unique per instance.
   */
  exclusive?: boolean;
  /** Deleted by the broker once its last consumer goes. */
  autoDelete?: boolean;
  /** A message still queued after this long is discarded (`x-message-ttl`). */
  messageTtlMs?: number;
  /** Holds at most this many messages, discarding the oldest (`x-max-length`). */
  maxLength?: number;
}

/**
 * An exclusive or auto-delete queue is transient: not durable, and given no
 * retry or dead-letter topology. A message its handler fails on is dropped, so
 * its handler must be idempotent and its effect must have another fallback.
 */
export const isTransient = (spec: SubscriptionSpec): boolean =>
  Boolean(spec.exclusive || spec.autoDelete);

/**
 * Fanout exchange and queue for a given attempt, scoped to one service.
 *
 * A queue's TTL is fixed at declaration: re-declaring it with a different
 * `messageTtl` fails with PRECONDITION_FAILED and kills the channel. Globally
 * named retry queues would therefore force every service onto one backoff
 * forever, and changing it would mean deleting the queues first. Scoping them
 * to the consuming service removes that coupling.
 *
 * Named `delay`, not `retry` as first released: those queues dead-lettered onto
 * the topic exchange, and for the same reason their arguments cannot be changed
 * in place. A broker that still has `foc.<service>.retry.N` can delete them.
 */
export const retryExchangeName = (namespace: string, attempt: number): string =>
  `foc.${namespace}.delay.${attempt}`;
export const retryQueueName = (namespace: string, attempt: number): string =>
  `foc.${namespace}.delay.${attempt}`;
export const deadLetterQueueName = (queue: string): string => `${queue}.dlq`;

/**
 * Delays are a parameter rather than a constant so a deployment can tune the
 * backoff, and so an integration test can exercise the whole retry path
 * without waiting eighty seconds for it.
 */
export function retryLevels(
  namespace: string,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Array<{ exchange: string; queue: string; ttlMs: number }> {
  return delays.map((ttlMs, i) => ({
    exchange: retryExchangeName(namespace, i + 1),
    queue: retryQueueName(namespace, i + 1),
    ttlMs,
  }));
}
