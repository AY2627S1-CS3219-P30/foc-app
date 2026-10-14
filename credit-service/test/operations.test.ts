import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrokerConnection,
  DEAD_LETTERS,
  DEAD_LETTERS_TABLE_SQL,
  DLX,
  EVENTS,
  EventConsumer,
  EventPublisher,
  createEnvelope,
  type DeadLetters,
} from '@foc/platform';
import { createMemoryBroker, type MemoryBroker } from '@foc/test-harness';
import { CREDIT_ECONOMIC_SUBSCRIPTIONS } from '../src/closed-economy.js';
import { RESERVATION_QUEUE } from '../src/reservation-consumer.js';
import { WALLET_QUEUE, WalletProvisioning } from '../src/wallet-provisioning.js';
import { asAdmin, asStudent, createTestApp, http, issue, type TestApp } from './helpers/app.js';

const SUBSCRIPTIONS = CREDIT_ECONOMIC_SUBSCRIPTIONS.map(({ queue, routingKeys }) => ({
  queue,
  routingKeys: [...routingKeys],
}));

/** The Credit Service's broker topology over an in-memory broker, with short retry delays. */
async function withBroker(): Promise<{
  memory: MemoryBroker;
  broker: BrokerConnection;
  t: TestApp;
}> {
  const memory = createMemoryBroker();
  const broker = new BrokerConnection('amqp://memory', 'credit-service', SUBSCRIPTIONS, [5, 5], {
    connect: memory.connect,
  });
  const t = await createTestApp({ broker });
  return { memory, broker, t };
}

const count = async (t: TestApp, sql: string, params: unknown[] = []) =>
  Number((await t.db.query<{ n: number }>(sql, params)).rows[0]!.n);

/** Every row that holds credit, so a test can show something changed none of them. */
const creditRows = async (t: TestApp) => ({
  wallets: await count(t, 'SELECT count(*)::int AS n FROM wallets'),
  transactions: await count(t, 'SELECT count(*)::int AS n FROM credit_transactions'),
  entries: await count(t, 'SELECT count(*)::int AS n FROM ledger_entries'),
  operations: await count(t, 'SELECT count(*)::int AS n FROM credit_operations'),
});

const waiting = async (t: TestApp) =>
  (
    await http(t)
      .get('/admin/dead-letters?status=WAITING')
      .set('Authorization', asAdmin)
      .expect(200)
  ).body as { total: number; items: Array<Record<string, unknown> & { id: string }> };

describe('operations (PLT-05)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('issues exactly one wallet when a dead-lettered user.activated is redriven', async () => {
    const { memory, broker, t } = await withBroker();
    close = async () => {
      await broker.close();
      await t.close();
    };
    await new WalletProvisioning(
      new EventConsumer(broker),
      t.db,
      t.credits,
    ).onApplicationBootstrap();
    await broker.connect();

    // Wallets cannot be written, so the activation fails every attempt and is dead-lettered.
    await t.db.exec(`
      CREATE FUNCTION refuse_wallets() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'wallets table unavailable'; END; $$;
      CREATE TRIGGER refuse_wallets BEFORE INSERT ON wallets
        FOR EACH ROW EXECUTE FUNCTION refuse_wallets();
    `);
    const activation = await new EventPublisher(broker, 'user-service').publish({
      eventType: EVENTS.USER_ACTIVATED,
      schemaVersion: 1,
      aggregateId: 'student-9',
      correlationId: 'activation-trace',
      payload: { userId: 'student-9', activatedAt: '2026-10-08T08:00:00.000Z' },
    });

    await expect.poll(async () => (await waiting(t)).total, { timeout: 5_000 }).toBe(1);
    const [parked] = (await waiting(t)).items;
    expect(parked).toMatchObject({
      queue: WALLET_QUEUE,
      eventId: activation.eventId,
      eventType: EVENTS.USER_ACTIVATED,
      aggregateId: 'student-9',
      correlationId: 'activation-trace',
      attempts: 3,
      status: 'WAITING',
    });
    expect(parked!.failureReason).toContain('wallets table unavailable');
    expect(await creditRows(t)).toEqual({ wallets: 0, transactions: 0, entries: 0, operations: 0 });
    expect((await http(t).get('/metrics').expect(200)).text).toMatch(
      /foc_dead_letters_waiting\{[^}]*queue="foc\.credit\.wallet-provisioning"[^}]*\} 1/,
    );

    // The fault is fixed; an operator redrives the message as it was.
    await t.db.exec('DROP TRIGGER refuse_wallets ON wallets; DROP FUNCTION refuse_wallets();');
    const redriven = await http(t)
      .post(`/admin/dead-letters/${parked!.id}/redrive`)
      .set('Authorization', asAdmin)
      .set('X-Correlation-Id', 'operator-redrive')
      .send({ reason: 'wallets table restored' })
      .expect(200);
    expect(redriven.body).toMatchObject({
      status: 'REDRIVEN',
      redrivenBy: 'admin-1',
      redriveReason: 'wallets table restored',
    });
    await expect
      .poll(() => count(t, `SELECT count(*)::int AS n FROM wallets WHERE user_id = 'student-9'`))
      .toBe(1);

    // A second redrive is refused, and a duplicate delivery of the same event is absorbed.
    await http(t)
      .post(`/admin/dead-letters/${parked!.id}/redrive`)
      .set('Authorization', asAdmin)
      .send({ reason: 'again' })
      .expect(409);
    memory.publish('', WALLET_QUEUE, activation, { persistent: true });
    await expect.poll(() => memory.depth(WALLET_QUEUE)).toBe(0);

    const wallet = await t.db.query(
      `SELECT available, reserved FROM wallets WHERE user_id = 'student-9'`,
    );
    expect(wallet.rows).toEqual([{ available: 10, reserved: 0 }]);
    expect(
      await count(
        t,
        `SELECT count(*)::int AS n FROM credit_transactions
          WHERE transaction_type = 'ISSUE' AND wallet_user_id = 'student-9'`,
      ),
    ).toBe(1);
    expect(await count(t, 'SELECT count(*)::int AS n FROM ledger_entries')).toBe(2);
    expect(
      await count(t, 'SELECT count(*)::int AS n FROM processed_events WHERE event_id = $1', [
        activation.eventId,
      ]),
    ).toBe(1);
    expect((await waiting(t)).total).toBe(0);
    expect((await http(t).get('/metrics').expect(200)).text).toMatch(
      /foc_dead_letters_waiting\{[^}]*queue="foc\.credit\.wallet-provisioning"[^}]*\} 0/,
    );
  });

  it('moves no credit itself: a redrive only puts the stored message back on its queue', async () => {
    const { memory, broker, t } = await withBroker();
    close = async () => {
      await broker.close();
      await t.close();
    };
    await broker.connect(); // no consumer for the queue: whatever is redriven stays on it
    const request = createEnvelope({
      eventType: EVENTS.CREDIT_RESERVATION_REQUESTED,
      schemaVersion: 1,
      aggregateId: randomUUID(),
      producer: 'order-service',
      correlationId: 'reservation-trace',
      payload: { anything: 'stored as it came' },
    });
    memory.publish(DLX, RESERVATION_QUEUE, request, {
      headers: { 'x-foc-attempt': 5, 'x-foc-failure-reason': 'credit db down' },
    });
    await expect.poll(async () => (await waiting(t)).total).toBe(1);
    const [parked] = (await waiting(t)).items;
    const before = await creditRows(t);

    await http(t)
      .post(`/admin/dead-letters/${parked!.id}/redrive`)
      .set('Authorization', asAdmin)
      .send({ reason: 'credit db back' })
      .expect(200);

    expect(await creditRows(t)).toEqual(before);
    expect(memory.depth(RESERVATION_QUEUE)).toBe(1);
  });

  it("traces Credit's half of an errand: operations, transactions, alerts and dead letters", async () => {
    const t = await createTestApp();
    close = () => t.close();
    const orderId = randomUUID();
    await issue(t, 'student-1');
    const reservation = { orderId, requesterId: 'student-1', correlationId: 'trace-1' };
    await t.db.transaction((tx) =>
      t.credits.reserve(tx, { ...reservation, amount: 3, causationId: 'reserve-1' }),
    );
    // The same order asked for again at another price: refused, and an audit alert raised.
    await t.db.transaction((tx) =>
      t.credits.reserve(tx, { ...reservation, amount: 4, causationId: 'reserve-2' }),
    );
    const channel = { ack: () => undefined, nack: () => undefined } as unknown as ConfirmChannel;
    await t.app.get<DeadLetters>(DEAD_LETTERS).park(channel, RESERVATION_QUEUE, {
      content: Buffer.from(
        JSON.stringify(
          createEnvelope({
            eventType: EVENTS.CREDIT_RESERVATION_REQUESTED,
            schemaVersion: 1,
            aggregateId: orderId,
            producer: 'order-service',
            correlationId: 'trace-1',
            payload: {},
          }),
        ),
      ),
      fields: { routingKey: RESERVATION_QUEUE },
      properties: { headers: { 'x-foc-attempt': 5, 'x-foc-failure-reason': 'payload invalid' } },
    } as unknown as ConsumeMessage);

    const res = await http(t)
      .get(`/admin/orders/${orderId}/credit`)
      .set('Authorization', asAdmin)
      .expect(200);
    expect(res.body.orderId).toBe(orderId);
    expect(res.body.operations).toEqual([
      expect.objectContaining({
        operationType: 'RESERVE',
        requesterId: 'student-1',
        amount: 3,
        outcome: 'SUCCEEDED',
      }),
    ]);
    // No balance is shown here: wallet reads stay behind the recorded admin wallet routes.
    expect(res.body.operations[0]).not.toHaveProperty('availableAtDecision');
    expect(res.body.transactions).toEqual([
      expect.objectContaining({ transactionType: 'RESERVE', walletUserId: 'student-1', amount: 3 }),
    ]);
    expect(res.body.alerts).toEqual([
      expect.objectContaining({
        orderId,
        operationType: 'RESERVE',
        code: 'CONFLICTING_REQUEST',
        correlationId: 'trace-1',
      }),
    ]);
    expect(res.body.deadLetters).toEqual([
      expect.objectContaining({ queue: RESERVATION_QUEUE, failureReason: 'payload invalid' }),
    ]);

    const alerts = await http(t)
      .get('/admin/credit-alerts')
      .set('Authorization', asAdmin)
      .expect(200);
    expect(alerts.body.items).toEqual([
      expect.objectContaining({ orderId, code: 'CONFLICTING_REQUEST' }),
    ]);
  });

  it('keeps every operator route to administrators, and says when it cannot redrive', async () => {
    const t = await createTestApp(); // no broker
    close = () => t.close();
    const orderId = randomUUID();
    for (const path of [
      `/admin/orders/${orderId}/credit`,
      '/admin/credit-alerts',
      '/admin/dead-letters',
      `/admin/dead-letters/${randomUUID()}`,
    ]) {
      await http(t).get(path).set('Authorization', asStudent).expect(403);
      await http(t).get(path).expect(401);
    }
    await http(t)
      .post(`/admin/dead-letters/${randomUUID()}/redrive`)
      .set('Authorization', asStudent)
      .send({ reason: 'x' })
      .expect(403);
    await http(t).get('/admin/orders/order-1/credit').set('Authorization', asAdmin).expect(400);

    const channel = { ack: () => undefined, nack: () => undefined } as unknown as ConfirmChannel;
    await t.app.get<DeadLetters>(DEAD_LETTERS).park(channel, WALLET_QUEUE, {
      content: Buffer.from('{}'),
      fields: { routingKey: WALLET_QUEUE },
      properties: { headers: {} },
    } as unknown as ConsumeMessage);
    const [parked] = (await waiting(t)).items;
    const refused = await http(t)
      .post(`/admin/dead-letters/${parked!.id}/redrive`)
      .set('Authorization', asAdmin)
      .send({ reason: 'try' })
      .expect(503);
    expect(refused.body.error.code).toBe('BROKER_UNAVAILABLE');
  });

  it("migrates the platform's dead-letter table exactly", () => {
    const migration = readFileSync(
      new URL('../drizzle/0004_dead_letters.sql', import.meta.url),
      'utf8',
    );
    const normalise = (sql: string) =>
      sql
        .replace(/--> statement-breakpoint/g, '')
        .replace(/^--.*$/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    expect(normalise(migration)).toBe(normalise(DEAD_LETTERS_TABLE_SQL));
  });
});
