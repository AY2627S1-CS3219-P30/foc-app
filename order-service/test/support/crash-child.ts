/**
 * A real Order Service process that is SIGKILLed at a chosen point, for the kill-after-commit
 * tests (OS-NFR4.1.1). Run by order-recovery.postgres.test.ts; not a test itself.
 *
 *   CRASH_DATABASE_URL  the database to use
 *   CRASH_MODE          after-commit | mid-publish
 *   CRASH_OUT           file the child writes what it did before dying
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { OutboxRelay, PgDb, createEnvelope } from '@foc/platform';
import { OrdersRepository } from '../../src/orders/orders.repository.js';

const db = new PgDb(process.env.CRASH_DATABASE_URL!);
const orders = new OrdersRepository(db);
const out = process.env.CRASH_OUT!;
const die = () => process.kill(process.pid, 'SIGKILL');

if (process.env.CRASH_MODE === 'after-commit') {
  // Two committed transitions, then the process dies before any relay runs.
  const created = await orders.createPending({
    supplierId: '00000000-0000-4000-8000-000000000125',
    items: [{ name: 'Tea', quantity: 1 }],
    deliveryZone: 'COM2 Lobby',
    deliveryInstructions: 'Crash test',
    reward: 2,
    requesterId: 'seed-requester',
    supplierSnapshot: {
      supplierId: '00000000-0000-4000-8000-000000000125',
      name: 'The Deck',
      type: 'FOOD',
      building: 'COM2',
      floor: '1',
      locationDescription: 'Level 1 canteen',
    },
    idempotencyKey: randomUUID(),
    requestHash: randomUUID(),
    correlationId: 'crash-child',
  });
  const openId = process.env.CRASH_OPEN_ORDER!;
  const cancelled = await orders.transition({
    orderId: openId,
    action: 'CANCEL',
    actor: { kind: 'USER', id: 'seed-requester', isAdmin: false },
    correlationId: 'crash-child',
  });
  writeFileSync(
    out,
    JSON.stringify({
      pending: created.order.orderId,
      cancelled: openId,
      cancelKind: cancelled.kind,
    }),
  );
  die();
} else {
  // The broker accepts the first event, then the process dies before marking it published.
  const relay = new OutboxRelay({
    db,
    publisher: {
      publish: async (input) => {
        appendFileSync(
          out,
          `${JSON.stringify({ eventId: input.eventId, aggregateId: input.aggregateId, eventType: input.eventType })}\n`,
        );
        die();
        return createEnvelope({ ...input, producer: 'order-service' });
      },
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  await relay.tick();
}
