import { randomUUID } from 'node:crypto';
import {
  CORRELATION_HEADER,
  EventPublisher,
  EVENTS,
  insertOutboxEvent,
  OutboxRelay,
  PAYLOAD_SCHEMAS,
  parseEnvelope,
  runMigrations,
  userStatusChangedPayload,
  type BrokerConnection,
  type Envelope,
} from '@foc/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { migrations } from '../src/db/migrations.js';
import { createTestApp, type TestApp } from './helpers/app.js';
import {
  activeStudent,
  bearer,
  http,
  seededAdmin,
  TRUNCATE_ALL,
  type Actor,
} from './helpers/actors.js';
import { PgliteDb } from './helpers/pglite-db.js';

/**
 * EVT-02 from the User Service's side: what it writes to its outbox is what the platform relay
 * publishes, under the catalogue's routing keys, in a shape every consumer accepts.
 */

interface Sent {
  routingKey: string;
  body: Buffer;
  envelope: Envelope;
}

/** The real EventPublisher over a fake confirm channel that records each message as sent. */
function fakeBroker() {
  const sent: Sent[] = [];
  const channel = {
    publish(_exchange: string, routingKey: string, body: Buffer, _o: unknown, cb: () => void) {
      sent.push({ routingKey, body, envelope: JSON.parse(body.toString('utf8')) });
      cb();
      return true;
    },
  };
  const broker = { getChannel: () => channel } as unknown as BrokerConnection;
  return { sent, publisher: new EventPublisher(broker, 'user-service') };
}

const quiet = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

let t: TestApp;
let admin: Actor;
let student: Actor;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.exec(TRUNCATE_ALL);
  admin = await seededAdmin(t, 'root1@u.nus.edu');
  student = await activeStudent(t, 'student@u.nus.edu');
});

describe('outbox relay', () => {
  it('publishes an admin suspension as user.suspended, in the shape its consumers accept', async () => {
    await http(t)
      .post(`/admin/users/${student.id}/suspend`)
      .set('Authorization', bearer(admin))
      .set(CORRELATION_HEADER, 'trace-suspend-1')
      .send({ reason: 'Repeated no-shows' })
      .expect(200);
    const { rows } = await t.db.query<{ id: string }>(
      `SELECT id FROM outbox_events WHERE event_type = 'user.suspended'`,
    );
    expect(rows).toHaveLength(1);

    const broker = fakeBroker();
    await new OutboxRelay({ db: t.db, publisher: broker.publisher, logger: quiet() }).tick();

    const suspended = broker.sent.filter((m) => m.routingKey === EVENTS.USER_SUSPENDED);
    expect(suspended).toHaveLength(1);
    // Parsed exactly as auth-client's status subscription parses it.
    const event = parseEnvelope(suspended[0]!.body, userStatusChangedPayload);
    expect(event).toMatchObject({
      eventId: rows[0]!.id,
      eventType: 'user.suspended',
      aggregateId: student.id,
      producer: 'user-service',
      correlationId: 'trace-suspend-1',
    });
    expect(event.payload).toMatchObject({ userId: student.id, status: 'SUSPENDED' });
  });

  it('relays every event the service writes, each valid against the catalogue under its own key', async () => {
    const as = (path: string, body: object) =>
      http(t).post(path).set('Authorization', bearer(admin)).send(body);
    await as(`/admin/users/${student.id}/suspend`, { reason: 'r' }).expect(200);
    await as(`/admin/users/${student.id}/reactivate`, { reason: 'r' }).expect(200);
    await http(t)
      .put(`/admin/users/${student.id}/role`)
      .set('Authorization', bearer(admin))
      .send({ role: 'ADMIN', reason: 'r' })
      .expect(200);

    const broker = fakeBroker();
    await new OutboxRelay({ db: t.db, publisher: broker.publisher, logger: quiet() }).tick();

    const { rows: left } = await t.db.query(
      'SELECT event_type, last_error FROM outbox_events WHERE published_at IS NULL',
    );
    expect(left).toEqual([]);
    const schemas: Partial<Record<string, z.ZodType>> = PAYLOAD_SCHEMAS;
    for (const { routingKey, body, envelope } of broker.sent) {
      expect(envelope.eventType).toBe(routingKey);
      expect(schemas[routingKey], `${routingKey} is in the catalogue`).toBeDefined();
      expect(() => parseEnvelope(body, schemas[routingKey]!)).not.toThrow();
    }
    for (const key of [EVENTS.USER_ACTIVATED, EVENTS.USER_SUSPENDED, EVENTS.USER_REACTIVATED]) {
      expect(
        broker.sent.some((m) => m.routingKey === key),
        key,
      ).toBe(true);
    }
  });
});

describe('migration 006', () => {
  it('keeps rows written before it and relays them in the order they happened', async () => {
    const db = await PgliteDb.create();
    await runMigrations(
      db,
      migrations.filter((m) => m.id < '006'),
    );
    const userId = randomUUID();
    const row = (minutesAgo: number, status: 'SUSPENDED' | 'ACTIVE') => ({
      id: randomUUID(),
      type: status === 'SUSPENDED' ? EVENTS.USER_SUSPENDED : EVENTS.USER_REACTIVATED,
      minutesAgo,
      payload: { userId, status, occurredAt: new Date().toISOString() },
    });
    // Inserted newest first, so the table's physical order is the reverse of what happened.
    const reactivated = row(1, 'ACTIVE');
    const suspended = row(2, 'SUSPENDED');
    for (const r of [reactivated, suspended]) {
      await db.query(
        `INSERT INTO outbox_events (id, event_type, aggregate_id, payload, correlation_id, occurred_at)
         VALUES ($1, $2, $3, $4::jsonb, 'legacy', now() - make_interval(mins => $5))`,
        [r.id, r.type, userId, JSON.stringify(r.payload), r.minutesAgo],
      );
    }

    await runMigrations(db, migrations);
    // A row written after the migration sorts after the renumbered ones.
    const later = await db.transaction((tx) =>
      insertOutboxEvent(tx, {
        eventType: EVENTS.USER_SUSPENDED,
        aggregateId: userId,
        correlationId: 'new',
        payload: { userId, status: 'SUSPENDED', occurredAt: new Date().toISOString() },
      }),
    );

    const broker = fakeBroker();
    const relay = new OutboxRelay({ db, publisher: broker.publisher, logger: quiet() });
    expect(await relay.tick()).toBe(3);
    expect(broker.sent.map((m) => m.envelope.eventId)).toEqual([
      suspended.id,
      reactivated.id,
      later,
    ]);
    expect(broker.sent[0]!.envelope.payload).toEqual(suspended.payload);
    await db.close();
  });
});
