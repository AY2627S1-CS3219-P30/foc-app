import { describe, expect, it } from 'vitest';
import { PAYLOAD_SCHEMAS, runMigrations } from '@foc/platform';
import { migrations } from '../src/db/migrations.js';
import { PgliteDb } from './helpers/pglite-db.js';

const ALEX = '00000000-0000-4000-8000-0000000000a1';
const SAM = '00000000-0000-4000-8000-0000000000a2'; // no recorded activation time
const row = (n: number) => `00000000-0000-4000-8000-0000000000b${n}`;

describe('migration 005 on an outbox written before USR-07', () => {
  it('rewrites unpublished legacy events to the catalogue keys and shapes, and leaves published ones alone', async () => {
    const db = await PgliteDb.create();
    try {
      await runMigrations(
        db,
        migrations.filter((m) => m.id < '005'),
      );
      await db.query(
        `INSERT INTO users (id, email, password_hash, status, activated_at) VALUES
         ($1, 'alex@u.nus.edu', 'h', 'ACTIVE', '2026-09-01T08:00:00.123Z'),
         ($2, 'sam@u.nus.edu', 'h', 'ACTIVE', NULL)`,
        [ALEX, SAM],
      );
      // Exactly what the service wrote before USR-07: old type names, payloads without timestamps.
      const legacy = [
        [row(1), 'UserActivated', ALEX, { userId: ALEX }, '2026-09-01T08:00:01Z', null],
        [row(2), 'UserActivated', SAM, { userId: SAM }, '2026-09-01T09:00:00Z', null],
        [
          row(3),
          'UserSuspended',
          ALEX,
          { userId: ALEX, status: 'SUSPENDED', reasonRef: 'audit-1' },
          '2026-09-02T09:30:00.5Z',
          null,
        ],
        [
          row(4),
          'UserReactivated',
          ALEX,
          { userId: ALEX, status: 'ACTIVE', reasonRef: 'audit-2' },
          '2026-09-03T10:00:00Z',
          null,
        ],
        [
          row(5),
          'UserSuspended',
          SAM,
          { userId: SAM, status: 'SUSPENDED', reasonRef: 'audit-3' },
          '2026-09-04T00:00:00Z',
          '2026-09-04T00:00:01Z', // already published: history, not rewritten
        ],
      ] as const;
      for (const [id, type, aggregate, payload, occurredAt, publishedAt] of legacy) {
        await db.query(
          `INSERT INTO outbox_events
             (id, event_type, aggregate_id, payload, correlation_id, occurred_at, published_at)
           VALUES ($1, $2, $3, $4::jsonb, 'legacy', $5, $6)`,
          [id, type, aggregate, JSON.stringify(payload), occurredAt, publishedAt],
        );
      }

      await runMigrations(db, migrations);

      const rows = (
        await db.query<{ id: string; event_type: string; payload: Record<string, unknown> }>(
          'SELECT id, event_type, payload FROM outbox_events ORDER BY id',
        )
      ).rows;
      expect(rows).toEqual([
        {
          id: row(1),
          event_type: 'user.activated',
          payload: { userId: ALEX, activatedAt: '2026-09-01T08:00:00.123Z' },
        },
        {
          id: row(2),
          event_type: 'user.activated',
          // No activation time on the account: when the event was written is the best evidence.
          payload: { userId: SAM, activatedAt: '2026-09-01T09:00:00.000Z' },
        },
        {
          id: row(3),
          event_type: 'user.suspended',
          payload: {
            userId: ALEX,
            status: 'SUSPENDED',
            reasonRef: 'audit-1',
            occurredAt: '2026-09-02T09:30:00.500Z',
          },
        },
        {
          id: row(4),
          event_type: 'user.reactivated',
          payload: {
            userId: ALEX,
            status: 'ACTIVE',
            reasonRef: 'audit-2',
            occurredAt: '2026-09-03T10:00:00.000Z',
          },
        },
        {
          id: row(5),
          event_type: 'UserSuspended',
          payload: { userId: SAM, status: 'SUSPENDED', reasonRef: 'audit-3' },
        },
      ]);
      // Every rewritten row is now exactly what its consumers subscribe with.
      for (const r of rows.slice(0, 4)) {
        const schema = PAYLOAD_SCHEMAS[r.event_type as keyof typeof PAYLOAD_SCHEMAS];
        expect(schema.safeParse(r.payload).success, r.event_type).toBe(true);
      }
    } finally {
      await db.close();
    }
  });
});
