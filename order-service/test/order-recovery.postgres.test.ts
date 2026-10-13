import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EVENTS,
  OutboxRelay,
  createEnvelope,
  withInbox,
  type EventConsumer,
  type NewEventInput,
} from '@foc/platform';
import type { PgDb } from '@foc/platform';
import {
  createEphemeralPostgres,
  TEST_POSTGRES_URL,
  type EphemeralPostgres,
} from '@foc/test-harness';
import {
  RESERVATION_RESULTS_QUEUE,
  ReservationResultsConsumer,
} from '../src/reservation-results.consumer.js';
import { OrdersRepository } from '../src/orders/orders.repository.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;
let databaseUrl = '';
const SEEDED_ORDER = '00000000-0000-4000-8000-000000000129';
const CHILD = fileURLToPath(new URL('./support/crash-child.ts', import.meta.url));

/** Runs the child process to its SIGKILL and returns what it recorded. */
function crash(mode: 'after-commit' | 'mid-publish', env: Record<string, string> = {}) {
  const out = join(mkdtempSync(join(tmpdir(), 'foc-crash-')), 'out');
  const result = spawnSync(process.execPath, ['--import', 'tsx', CHILD], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      CRASH_DATABASE_URL: databaseUrl,
      CRASH_MODE: mode,
      CRASH_OUT: out,
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.signal, result.stderr).toBe('SIGKILL');
  return readFileSync(out, 'utf8');
}

suite('kill-after-commit recovery on real PostgreSQL (OS-NFR4.1)', () => {
  let database: EphemeralPostgres;
  let db: PgDb;
  let orders: OrdersRepository;

  beforeAll(async () => {
    database = await createEphemeralPostgres({
      adminUrl: TEST_POSTGRES_URL!,
      label: 'order_recovery',
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    db = database.db;
    databaseUrl = database.url;
    orders = new OrdersRepository(db);
    // The migration's seed rows are unpublished; the relays below must see only this suite's.
    await db.query(`UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL`);
  });
  afterAll(async () => database?.dispose());

  const openOrder = async () => {
    const orderId = randomUUID();
    await db.query(
      `INSERT INTO orders (order_id, requester_id, supplier_snapshot, items, delivery_zone,
                           delivery_instructions, reward, status, version, acceptance_deadline_at)
       SELECT $1, requester_id, supplier_snapshot, items, delivery_zone, delivery_instructions,
              reward, 'OPEN', 2, now() + interval '60 minutes'
         FROM orders WHERE order_id = $2`,
      [orderId, SEEDED_ORDER],
    );
    return orderId;
  };

  const recordingRelay = (published: NewEventInput<unknown>[]) =>
    new OutboxRelay({
      db,
      publisher: {
        publish: async (input) => {
          published.push(input);
          return createEnvelope({ ...input, producer: 'order-service' });
        },
      },
      logger: { log() {}, warn() {}, error() {} },
    });

  it('publishes every event committed before a SIGKILL, once, after restart, and the pending order reconciles', async () => {
    const recorded = JSON.parse(crash('after-commit', { CRASH_OPEN_ORDER: await openOrder() }));
    expect(recorded.cancelKind).toBe('applied');

    // After the "restart": committed state survived, nothing was published.
    expect(await orders.findById(recorded.pending)).toMatchObject({ status: 'PENDING_CREDIT' });
    expect(await orders.findById(recorded.cancelled)).toMatchObject({
      status: 'RELEASE_PENDING_CREDIT',
    });
    const mine = [recorded.pending, recorded.cancelled];

    const published: NewEventInput<unknown>[] = [];
    await recordingRelay(published).tick();
    await recordingRelay(published).tick(); // a second relay finds nothing left
    const types = published
      .filter((event) => mine.includes(event.aggregateId))
      .map(
        (event) =>
          `${event.aggregateId === recorded.pending ? 'pending' : 'cancelled'}:${event.eventType}`,
      )
      .sort();
    expect(types).toEqual([
      `cancelled:${EVENTS.CREDIT_RELEASE_REQUESTED}`,
      `cancelled:${EVENTS.ORDER_STATUS_CHANGED}`,
      `pending:${EVENTS.CREDIT_RESERVATION_REQUESTED}`,
      `pending:${EVENTS.ORDER_STATUS_CHANGED}`,
    ]);

    // Credit answers the republished request: the pending order opens with no manual step.
    const recorder: { handler?: (envelope: never, ctx: never) => Promise<void> } = {};
    await new ReservationResultsConsumer(
      {
        subscribe: async (options: { handler: never }) => void (recorder.handler = options.handler),
      } as unknown as EventConsumer,
      db,
      orders,
    ).onApplicationBootstrap();
    await recorder.handler!(
      createEnvelope({
        eventType: EVENTS.CREDITS_RESERVED,
        schemaVersion: 1,
        aggregateId: recorded.pending,
        producer: 'credit-service',
        correlationId: 'crash-recovery',
        payload: { orderId: recorded.pending, requesterId: 'seed-requester', amount: 2 },
      }) as never,
      { attempt: 1, queue: RESERVATION_RESULTS_QUEUE } as never,
    );
    expect(await orders.findById(recorded.pending)).toMatchObject({ status: 'OPEN' });
  });

  it('republishes an event under the same ID after a SIGKILL mid-publish, so a consumer applies it once', async () => {
    const orderId = await openOrder();
    await orders.transition({
      orderId,
      action: 'CANCEL',
      actor: { kind: 'USER', id: 'seed-requester', isAdmin: false },
      correlationId: 'mid-publish',
    });
    const sentBeforeDeath = JSON.parse(crash('mid-publish').trim().split('\n')[0]!);

    const published: NewEventInput<unknown>[] = [];
    await recordingRelay(published).tick();
    const resent = published.find((event) => event.eventId === sentBeforeDeath.eventId);
    expect(resent, 'the event the broker saw is sent again under the same ID').toBeDefined();

    // A downstream consumer sees it twice and applies it once.
    await db.exec(`CREATE TABLE IF NOT EXISTS recovery_effects (event_id uuid NOT NULL)`);
    const consume = withInbox(db, `downstream-${randomUUID()}`, async (envelope, tx) => {
      await tx.query(`INSERT INTO recovery_effects (event_id) VALUES ($1)`, [envelope.eventId]);
    });
    for (const delivery of [sentBeforeDeath, resent!]) {
      await consume(
        createEnvelope({
          eventId: delivery.eventId,
          eventType: delivery.eventType,
          schemaVersion: 1,
          aggregateId: delivery.aggregateId,
          producer: 'order-service',
          correlationId: 'downstream',
          payload: {},
        }) as never,
        { attempt: 1, queue: 'downstream' },
      );
    }
    const effects = await db.query(`SELECT * FROM recovery_effects WHERE event_id = $1`, [
      sentBeforeDeath.eventId,
    ]);
    expect(effects.rows).toHaveLength(1);
  });
});
