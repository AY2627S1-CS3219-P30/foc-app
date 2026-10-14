/**
 * Who published a message, as the broker vouches for it (PLT-06).
 *
 * An envelope's `producer` is a claim written by whoever built the message. RabbitMQ can back it:
 * it checks the `user-id` property of a published message against the login of the connection
 * that published it and refuses a mismatch, and that property travels with the message through
 * exchange bindings and dead-lettering. So when each service signs in with an account of its own,
 * `user-id` says which service a message really came from, whatever route it took to a queue. The
 * broker's routing-key permissions alone do not: they are checked only on the exchange a client
 * publishes to, and a service allowed to write to the shared exchange can bind another exchange
 * of its own into it.
 *
 * A service also publishes other services' messages again itself: a retry, a dead letter, a
 * redrive. It must do that under its own account (the broker would refuse the original one), so
 * it records the first sender in a header. That header is believed only on a message published
 * under the reader's own account, which nobody else can do.
 */

/** The broker account that first published a message, kept across its consumer's republishing. */
export const HEADER_SENDER = 'x-foc-sender';

interface SenderProperties {
  userId?: unknown;
  headers?: Record<string, unknown>;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * The account that first published the message, or `undefined` if its publisher did not say.
 * `ownAccount` is the reader's own broker account.
 */
export function senderOf(
  properties: SenderProperties,
  ownAccount: string | undefined,
): string | undefined {
  const userId = text(properties.userId);
  if (userId !== undefined && userId === ownAccount) {
    return text(properties.headers?.[HEADER_SENDER]) ?? userId;
  }
  return userId;
}

/**
 * The properties to publish a received message again with, under this service's own account,
 * keeping who first sent it. Without an account of its own the service claims none.
 */
export function resendProperties<P extends SenderProperties>(
  properties: P,
  ownAccount: string | undefined,
): P & { userId: string | undefined; headers: Record<string, unknown> } {
  const sender = senderOf(properties, ownAccount);
  return {
    ...properties,
    userId: ownAccount,
    headers: { ...(properties.headers ?? {}), ...(sender ? { [HEADER_SENDER]: sender } : {}) },
  };
}
