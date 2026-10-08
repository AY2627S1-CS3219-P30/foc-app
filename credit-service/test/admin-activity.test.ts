import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asAdmin, asStudent, createTestApp, http, issue, type TestApp } from './helpers/app.js';

const THRESHOLD = 3;

/** ADM-04: one admin reading many wallets in an hour is flagged, once an hour, and logged. */
describe('watching the admins: bulk wallet reads (ADM-04)', () => {
  let t: TestApp;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    t = await createTestApp({ walletReadsAlertPerHour: THRESHOLD });
    for (const user of ['user-a', 'user-b', 'user-c', 'user-d']) await issue(t, user);
    warn = vi.spyOn(Logger.prototype, 'warn');
  });
  afterEach(async () => {
    warn.mockRestore();
    await t.close();
  });

  const read = (userId: string, what: 'wallet' | 'ledger' = 'wallet') =>
    http(t)
      .get(`/admin/wallets/${userId}${what === 'ledger' ? '/ledger' : ''}`)
      .set('Authorization', asAdmin)
      .expect(200);
  const alerts = async () =>
    (await http(t).get('/admin/activity-alerts').set('Authorization', asAdmin).expect(200)).body
      .items as Array<{ kind: string; actorId: string; details: Record<string, number> }>;
  const raisedLogs = () =>
    warn.mock.calls.filter(
      ([entry]) => (entry as { alert?: string })?.alert === 'BULK_WALLET_READS',
    );

  it('counts wallets, not reads: one wallet and its ledger, read again and again, stay below', async () => {
    for (let i = 0; i < 5; i++) {
      await read('user-a');
      await read('user-a', 'ledger');
    }
    await read('user-b');
    expect(await alerts()).toEqual([]);
  });

  it('raises the alert at the threshold, once, and writes it to the log', async () => {
    await read('user-a');
    await read('user-b');
    expect(await alerts()).toEqual([]);

    await read('user-c', 'ledger');
    expect(await alerts()).toEqual([
      expect.objectContaining({
        kind: 'BULK_WALLET_READS',
        actorId: 'admin-1',
        details: { walletsInLastHour: 3, threshold: THRESHOLD },
      }),
    ]);
    expect(raisedLogs()).toHaveLength(1);
    expect(raisedLogs()[0]![0]).toMatchObject({ actorId: 'admin-1', walletsInLastHour: 3 });

    // More reads within the hour add no second alert.
    await read('user-d');
    await read('user-a');
    expect(await alerts()).toHaveLength(1);
    expect(raisedLogs()).toHaveLength(1);
  });

  it('raises it again an hour after the last one', async () => {
    await t.db.query(
      `INSERT INTO admin_activity_alerts (alert_id, kind, actor_id, details, occurred_at)
       VALUES (gen_random_uuid(), 'BULK_WALLET_READS', 'admin-1', '{}', now() - interval '61 minutes')`,
    );
    for (const user of ['user-a', 'user-b', 'user-c']) await read(user);
    expect(await alerts()).toHaveLength(2);
  });

  it('keeps alerts: no edit, no delete', async () => {
    for (const user of ['user-a', 'user-b', 'user-c']) await read(user);
    await expect(
      t.db.query(`UPDATE admin_activity_alerts SET actor_id = 'someone-else'`),
    ).rejects.toThrow(/append-only/);
    await expect(t.db.query('DELETE FROM admin_activity_alerts')).rejects.toThrow(/append-only/);
    expect(await alerts()).toHaveLength(1);
  });

  it('shows the alerts to administrators only', async () => {
    await http(t).get('/admin/activity-alerts').set('Authorization', asStudent).expect(403);
    await http(t).get('/admin/activity-alerts').expect(401);
  });
});
