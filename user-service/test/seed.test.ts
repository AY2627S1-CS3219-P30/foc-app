import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '@foc/platform';
import { reportSeed, seedAdmins, type SeedResult } from '../src/admin/seed.js';
import { REFRESH_COOKIE } from '../src/auth/cookies.js';
import { JWT, type JwtService } from '../src/auth/jwt.service.js';
import { hashPassword } from '../src/auth/passwords.js';
import { newOpaqueToken, sha256Hex } from '../src/auth/tokens.js';
import type { Queryable } from '../src/db/db.js';
import { migrations } from '../src/db/migrations.js';
import { createTestApp, SERVICE_KEY, type TestApp } from './helpers/app.js';
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
    expect(again).toEqual({ created: [], skipped: [{ entry: 1, email: 'root@u.nus.edu' }] });
    expect((await t.db.query('SELECT 1 FROM users')).rows).toHaveLength(1);
  });

  it('creates one account when two bootstraps overlap (interleaved, not truly parallel)', async () => {
    // PGlite runs one transaction at a time, so this covers the skip path and the audit row and
    // event staying with their insert, not two connections racing: that race rests on the unique
    // index on lower(email), which a real Postgres enforces.
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
    expect(r.skipped).toEqual([{ entry: 1, email: 'alex@u.nus.edu' }]);
    expect((await t.db.query("SELECT 1 FROM user_roles WHERE role = 'ADMIN'")).rows).toHaveLength(
      0,
    );
    // Nothing was granted, so there is nothing to audit.
    expect((await t.db.query('SELECT 1 FROM audit_records')).rows).toHaveLength(0);
  });

  it('fails loudly on a misconfiguration', async () => {
    // The boot error is printed to the console: it names the entry and its domain, never the
    // address.
    const bad = (email: string) =>
      seedAdmins(t.db, { emails: [email], password: BOOTSTRAP_PASSWORD, allowedDomains: domains });
    await expect(bad('some.one@gmail.com')).rejects.toThrow(
      /^ADMIN_SEED_EMAILS address 1 of 1 has domain gmail\.com, which is not in ALLOWED_EMAIL_DOMAINS\.$/,
    );
    await expect(bad('some.one@gmail.com')).rejects.not.toThrow(/some\.one/);
    await expect(bad('some.one.u.nus.edu')).rejects.toThrow(
      /^ADMIN_SEED_EMAILS address 1 of 1 is not an email address\.$/,
    );
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

describe('the boot report names an entry by position, never by address (US-NFR4.1.1)', () => {
  const report = (result: SeedResult) => {
    const lines: string[] = [];
    reportSeed(
      {
        log: (message: string) => void lines.push(`log: ${message}`),
        warn: (message: string) => void lines.push(`warn: ${message}`),
      },
      result,
    );
    return lines;
  };

  it('counts the admins created and lists the skipped entries', async () => {
    await activeStudent(t, 'alex@u.nus.edu');
    await activeStudent(t, 'sam@u.nus.edu');
    const lines = report(
      await seed(['root@u.nus.edu', 'alex@u.nus.edu', 'new@u.nus.edu', 'sam@u.nus.edu']),
    );
    expect(lines).toEqual([
      'log: Seeded administrators: 2',
      'warn: Seed skipped ADMIN_SEED_EMAILS address(es) 2, 4 of 4: an account already exists and is never promoted',
    ]);
    expect(lines.join('\n')).not.toMatch(/@|alex|sam/);
  });

  it('says so when no administrator is configured', async () => {
    expect(report(await seedAdmins(t.db, { allowedDomains: domains }))).toEqual([
      'warn: No seeded administrators configured.',
    ]);
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

  it('a bootstrap admin cannot choose the bootstrap password as their own', async () => {
    await seed(['root@u.nus.edu']);
    await changePassword(t, 'root@u.nus.edu', BOOTSTRAP_PASSWORD, PASSWORD).expect(204);
    const back = await changePassword(t, 'root@u.nus.edu', PASSWORD, BOOTSTRAP_PASSWORD).expect(
      422,
    );
    expect(back.body.error.details).toEqual([
      expect.objectContaining({ field: 'newPassword', code: 'PASSWORD_UNCHANGED' }),
    ]);
    // An ordinary account is not told whether its choice happens to be the secret.
    await activeStudent(t, 'alex@u.nus.edu');
    await changePassword(t, 'alex@u.nus.edu', PASSWORD, BOOTSTRAP_PASSWORD).expect(204);
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
  const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
  const STUDENT_ID = '00000000-0000-4000-8000-000000000002';

  it('flags and signs out every bootstrap admin, audits them, and keeps old audit rows valid', async () => {
    const db = await PgliteDb.create();
    await runMigrations(db, migrations.slice(0, 3));
    // A deployment on 003: a bootstrap admin who signed in with the secret, a student, and an
    // audit row in the old shape (no actor_type), which the new CHECKs must accept.
    await db.query(
      `INSERT INTO users (id, email, password_hash, status, is_seeded_admin, created_at) VALUES
       ($1, 'root@u.nus.edu', $3, 'ACTIVE', true, '2020-01-01T00:00:00Z'),
       ($2, 'alex@u.nus.edu', 'h', 'ACTIVE', false, '2020-01-02T00:00:00Z')`,
      [ADMIN_ID, STUDENT_ID, await hashPassword(BOOTSTRAP_PASSWORD)],
    );
    await db.query(
      `INSERT INTO user_roles (user_id, role) VALUES ($1, 'STUDENT'), ($1, 'ADMIN'), ($2, 'STUDENT')`,
      [ADMIN_ID, STUDENT_ID],
    );
    await db.query(
      `INSERT INTO profiles (user_id, display_name) VALUES ($1, 'Administrator'), ($2, 'Alex')`,
      [ADMIN_ID, STUDENT_ID],
    );
    await db.query(
      `INSERT INTO audit_records (id, actor_id, target_user_id, action, reason, correlation_id)
       VALUES (gen_random_uuid(), $1, $2, 'SUSPEND', 'spam', 'c1')`,
      [ADMIN_ID, STUDENT_ID],
    );
    const adminSession = await sessionWrittenDirectly(db, ADMIN_ID);
    const studentSession = await sessionWrittenDirectly(db, STUDENT_ID);

    const app = await createTestApp({ db }); // applies 004, as the next boot would
    try {
      const rows = (await db.query('SELECT email, must_change_password FROM users ORDER BY email'))
        .rows;
      expect(rows).toEqual([
        { email: 'alex@u.nus.edu', must_change_password: false },
        { email: 'root@u.nus.edu', must_change_password: true },
      ]);

      const audit = (
        await db.query(
          `SELECT actor_id, actor_type, target_user_id, action, occurred_at, correlation_id
           FROM audit_records ORDER BY occurred_at`,
        )
      ).rows;
      expect(audit).toEqual([
        {
          actor_id: null,
          actor_type: 'SYSTEM',
          target_user_id: ADMIN_ID,
          action: 'ADMIN_BOOTSTRAP',
          occurred_at: new Date('2020-01-01T00:00:00Z'),
          correlation_id: 'migration-004',
        },
        expect.objectContaining({ actor_id: ADMIN_ID, actor_type: 'USER', action: 'SUSPEND' }),
      ]);

      // The admin's existing session is gone: refresh fails, and so does an admin route.
      const refreshed = await refresh(app, adminSession.cookie).expect(401);
      expect(refreshed.body.error.code).toBe('REFRESH_TOKEN_INVALID');
      const token = await accessToken(app, ADMIN_ID, adminSession.sid);
      await http(app).get('/admin/users').set('Authorization', `Bearer ${token}`).expect(401);
      // Nobody else was signed out.
      await refresh(app, studentSession.cookie).expect(200);

      // The way back in is the ordinary one: replace the bootstrap password, then sign in.
      await changePassword(app, 'root@u.nus.edu', BOOTSTRAP_PASSWORD, PASSWORD).expect(204);
      const admin = await login(app, 'root@u.nus.edu');
      await http(app).get('/admin/users').set('Authorization', bearer(admin)).expect(200);
    } finally {
      await app.close();
    }
  });

  it('a session a flagged account still holds is refused by refresh, the guard and introspection', async () => {
    // Login never starts one; this is a session from an instance still running code older than 004.
    await seed(['root@u.nus.edu']);
    const { id } = (await t.db.query<{ id: string }>('SELECT id FROM users')).rows[0]!;
    const session = await sessionWrittenDirectly(t.db, id);

    const token = await accessToken(t, id, session.sid);
    const guarded = await http(t)
      .get('/admin/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(guarded.body.error.code).toBe('UNAUTHENTICATED');
    const introspected = await http(t)
      .get(`/internal/introspect?sid=${session.sid}&sub=${id}`)
      .set('x-service-key', SERVICE_KEY)
      .expect(200);
    expect(introspected.body).toEqual({ active: false });

    const refreshed = await refresh(t, session.cookie).expect(403);
    expect(refreshed.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const left = await t.db.query('SELECT 1 FROM refresh_sessions WHERE revoked_at IS NULL');
    expect(left.rows).toHaveLength(0);
  });
});

/** A refresh session inserted as login did before migration 004, with no check of the flag. */
async function sessionWrittenDirectly(db: Queryable, userId: string) {
  const token = newOpaqueToken();
  const sid = randomUUID();
  await db.query(
    `INSERT INTO refresh_sessions (id, family_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
    [sid, randomUUID(), userId, sha256Hex(token)],
  );
  return { sid, cookie: `${REFRESH_COOKIE}=${token}` };
}

const accessToken = (app: TestApp, sub: string, sid: string) =>
  app.app.get<JwtService>(JWT).sign({ sub, sid });

const refresh = (app: TestApp, cookie: string) =>
  http(app)
    .post('/auth/refresh')
    .set('Cookie', cookie)
    .set('Origin', ORIGIN)
    .set('Content-Type', 'application/json');
