import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '@foc/platform';
import { seedAdmins } from '../src/admin/seed.js';
import { migrations } from '../src/db/migrations.js';
import { createTestApp, type TestApp } from './helpers/app.js';
import { PgliteDb } from './helpers/pglite-db.js';
import {
  activeStudent,
  BOOTSTRAP_PASSWORD,
  bearer,
  changePassword,
  http,
  login,
  ORIGIN,
  PASSWORD,
  seededAdmin,
  TRUNCATE_ALL,
} from './helpers/actors.js';

let t: TestApp;
const domains = ['u.nus.edu'];
const seed = (emails: string[]) =>
  seedAdmins(t.db, { emails, password: BOOTSTRAP_PASSWORD, allowedDomains: domains });

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.exec(TRUNCATE_ALL);
});

describe('seedAdmins (US-FR3.1.3)', () => {
  it('creates active, seeded administrators with hashed passwords', async () => {
    const r = await seed(['Root@U.NUS.edu']);
    expect(r).toEqual({ created: ['root@u.nus.edu'], skipped: [] });

    const u = (await t.db.query('SELECT * FROM users')).rows[0]!;
    expect(u).toMatchObject({
      status: 'ACTIVE',
      is_seeded_admin: true,
      must_change_password: true,
    });
    expect(String(u.password_hash)).toMatch(/^\$argon2id\$/);
    expect((await t.db.query('SELECT role FROM user_roles ORDER BY role')).rows).toEqual([
      { role: 'ADMIN' },
      { role: 'STUDENT' },
    ]);
  });

  it('is idempotent across restarts', async () => {
    await seed(['root@u.nus.edu']);
    const again = await seed(['root@u.nus.edu']);
    expect(again).toEqual({ created: [], skipped: ['root@u.nus.edu'] });
    expect((await t.db.query('SELECT 1 FROM users')).rows).toHaveLength(1);
  });

  it('creates one account when two boots run the bootstrap at once', async () => {
    const results = await Promise.all([seed(['root@u.nus.edu']), seed(['root@u.nus.edu'])]);
    expect(results.flatMap((r) => r.created)).toEqual(['root@u.nus.edu']);
    expect((await t.db.query('SELECT 1 FROM users')).rows).toHaveLength(1);
    expect((await t.db.query('SELECT 1 FROM audit_records')).rows).toHaveLength(1);
  });

  it('issues a wallet event for the seeded admin like any other student', async () => {
    await seed(['root@u.nus.edu']);
    const ev = (await t.db.query("SELECT * FROM outbox_events WHERE event_type = 'user.activated'"))
      .rows;
    expect(ev).toHaveLength(1);
  });

  it('never promotes an address that already has an ordinary account', async () => {
    await activeStudent(t, 'alex@u.nus.edu');
    const r = await seed(['alex@u.nus.edu']);
    expect(r.skipped).toEqual(['alex@u.nus.edu']);
    expect((await t.db.query("SELECT 1 FROM user_roles WHERE role = 'ADMIN'")).rows).toHaveLength(
      0,
    );
    // Nothing was granted, so there is nothing to audit.
    expect((await t.db.query('SELECT 1 FROM audit_records')).rows).toHaveLength(0);
  });

  it('fails loudly on a misconfiguration', async () => {
    await expect(
      seedAdmins(t.db, {
        emails: ['a@gmail.com'],
        password: BOOTSTRAP_PASSWORD,
        allowedDomains: domains,
      }),
    ).rejects.toThrow(/entry 1 is outside ALLOWED_EMAIL_DOMAINS/);
    // The boot error names the entry, never the address (it is printed to the console).
    await expect(
      seedAdmins(t.db, {
        emails: ['a@gmail.com'],
        password: BOOTSTRAP_PASSWORD,
        allowedDomains: domains,
      }),
    ).rejects.not.toThrow(/gmail/);
    await expect(
      seedAdmins(t.db, { emails: ['a@u.nus.edu'], allowedDomains: domains }),
    ).rejects.toThrow(/ADMIN_SEED_PASSWORD/);
    expect(await seedAdmins(t.db, { allowedDomains: domains })).toEqual({
      created: [],
      skipped: [],
    });
    expect((await t.db.query('SELECT 1 FROM users')).rows).toHaveLength(0);
  });
});

describe('the bootstrap secret is retired at first sign-in (US-FR3.1.3.2)', () => {
  it('refuses a session with the bootstrap password, and starts none', async () => {
    await seed(['root@u.nus.edu']);
    const res = await http(t)
      .post('/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'root@u.nus.edu', password: BOOTSTRAP_PASSWORD })
      .expect(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.accessToken).toBeUndefined();
    expect((await t.db.query('SELECT 1 FROM refresh_sessions')).rows).toHaveLength(0);
  });

  it('does not reveal the forced change to someone without the bootstrap password', async () => {
    await seed(['root@u.nus.edu']);
    const res = await http(t)
      .post('/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'root@u.nus.edu', password: 'a-wrong-guess-entirely' })
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('after the change, the new password works and the bootstrap password never does again', async () => {
    await seed(['root@u.nus.edu']);
    await changePassword(t, 'root@u.nus.edu', BOOTSTRAP_PASSWORD, PASSWORD).expect(204);

    const admin = await login(t, 'root@u.nus.edu');
    await http(t).get('/admin/users').set('Authorization', bearer(admin)).expect(200);

    const old = await http(t)
      .post('/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'root@u.nus.edu', password: BOOTSTRAP_PASSWORD })
      .expect(401);
    expect(old.body.error.code).toBe('INVALID_CREDENTIALS');
    // Nor can it be used to change the password a second time.
    await changePassword(t, 'root@u.nus.edu', BOOTSTRAP_PASSWORD, 'another-new-password').expect(
      401,
    );
  });

  it('a restart with the same configuration does not restore the bootstrap password', async () => {
    await seed(['root@u.nus.edu']);
    await changePassword(t, 'root@u.nus.edu', BOOTSTRAP_PASSWORD, PASSWORD).expect(204);
    await seed(['root@u.nus.edu']);
    await login(t, 'root@u.nus.edu', PASSWORD);
    const flag = (await t.db.query('SELECT must_change_password FROM users')).rows[0];
    expect(flag).toEqual({ must_change_password: false });
  });
});

describe('the bootstrap is audited (US-NFR4.1.2)', () => {
  it('writes one row per created admin, with the SYSTEM as actor and no secret', async () => {
    await seed(['root@u.nus.edu', 'root2@u.nus.edu']);
    const rows = (
      await t.db.query<{
        actor_id: string | null;
        actor_type: string;
        action: string;
        reason: string;
        target_user_id: string;
      }>('SELECT actor_id, actor_type, action, reason, target_user_id FROM audit_records')
    ).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        actor_id: null,
        actor_type: 'SYSTEM',
        action: 'ADMIN_BOOTSTRAP',
      });
      expect(row.reason).not.toContain(BOOTSTRAP_PASSWORD);
    }
    const ids = (await t.db.query<{ id: string }>('SELECT id FROM users')).rows.map((r) => r.id);
    expect(rows.map((r) => r.target_user_id).sort()).toEqual(ids.sort());
  });

  it('does not audit a restart that creates nothing', async () => {
    await seed(['root@u.nus.edu']);
    await seed(['root@u.nus.edu']);
    expect((await t.db.query('SELECT 1 FROM audit_records')).rows).toHaveLength(1);
  });

  it('is visible to administrators through the audit API as a SYSTEM action', async () => {
    const admin = await seededAdmin(t, 'root@u.nus.edu');
    const res = await http(t)
      .get('/admin/audit-records')
      .set('Authorization', bearer(admin))
      .expect(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        actorId: null,
        actorType: 'SYSTEM',
        targetUserId: admin.id,
        action: 'ADMIN_BOOTSTRAP',
      }),
    ]);
  });

  it('the table refuses a SYSTEM row that names a user, or a USER row that names nobody', async () => {
    const admin = await seededAdmin(t, 'root@u.nus.edu');
    const insert = (actorId: string | null, actorType: string) =>
      t.db.query(
        `INSERT INTO audit_records (id, actor_id, actor_type, target_user_id, action, reason, correlation_id)
         VALUES (gen_random_uuid(), $1, $2, $3, 'SUSPEND', 'x', 'c')`,
        [actorId, actorType, admin.id],
      );
    await expect(insert(admin.id, 'SYSTEM')).rejects.toThrow(/audit_records_actor_consistent/);
    await expect(insert(null, 'USER')).rejects.toThrow(/audit_records_actor_consistent/);
  });
});

describe('recovering from a misbehaving appointed admin (the seeded tier, US-FR3.1.3.1)', () => {
  it('a new bootstrap admin added through configuration can remove an appointed admin', async () => {
    // The only bootstrap admin appoints someone, then graduates: the account still exists, but
    // nobody is behind it any more. The appointed admin cannot be removed by any other admin.
    const original = await seededAdmin(t, 'root@u.nus.edu');
    const appointed = await activeStudent(t, 'appointed@u.nus.edu');
    await http(t)
      .put(`/admin/users/${appointed.id}/role`)
      .set('Authorization', bearer(original))
      .send({ role: 'ADMIN', reason: 'helping with moderation' })
      .expect(200);
    const blocked = await http(t)
      .post(`/admin/users/${original.id}/suspend`)
      .set('Authorization', bearer(appointed))
      .send({ reason: 'trying to take over' })
      .expect(403);
    expect(blocked.body.error.code).toBe('ADMIN_ACTION_NOT_PERMITTED');

    // The operators add a new address to ADMIN_SEED_EMAILS and redeploy: the recovery path needs
    // deployment access, which is the right authority, and no database edit.
    const successor = await seededAdmin(t, 'successor@u.nus.edu');
    await http(t)
      .put(`/admin/users/${appointed.id}/role`)
      .set('Authorization', bearer(successor))
      .send({ role: 'STUDENT', reason: 'misuse of admin role' })
      .expect(200);
  });
});

describe('migration 004 on a database that already has bootstrap admins', () => {
  it('forces every existing bootstrap admin to change the password, and nobody else', async () => {
    const db = await PgliteDb.create();
    try {
      await runMigrations(db, migrations.slice(0, 3));
      await db.query(
        `INSERT INTO users (id, email, password_hash, status, is_seeded_admin) VALUES
         ('00000000-0000-4000-8000-000000000001', 'root@u.nus.edu', 'h', 'ACTIVE', true),
         ('00000000-0000-4000-8000-000000000002', 'alex@u.nus.edu', 'h', 'ACTIVE', false)`,
      );
      await runMigrations(db, migrations);
      const rows = (await db.query('SELECT email, must_change_password FROM users ORDER BY email'))
        .rows;
      expect(rows).toEqual([
        { email: 'alex@u.nus.edu', must_change_password: false },
        { email: 'root@u.nus.edu', must_change_password: true },
      ]);
    } finally {
      await db.close();
    }
  });
});
