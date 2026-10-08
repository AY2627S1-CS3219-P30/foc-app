import request from 'supertest';
import { seedAdmins } from '../../src/admin/seed.js';
import type { TestApp } from './app.js';
import { validRegistration } from './app.js';

export const PASSWORD = validRegistration().password;
export const ORIGIN = 'http://localhost:3000';

export interface Actor {
  id: string;
  email: string;
  accessToken: string;
  cookie: string;
}

export const http = (t: TestApp) => request(t.app.getHttpServer());

export async function login(t: TestApp, email: string, password = PASSWORD): Promise<Actor> {
  const res = await http(t)
    .post('/auth/login')
    .set('Origin', ORIGIN)
    .send({ email, password })
    .expect(200);
  const cookie = ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .find((c) => c.startsWith('foc_refresh='))!
    .split(';')[0]!;
  return { id: res.body.user.id, email, accessToken: res.body.accessToken, cookie };
}

/** Registers, activates and logs in an ordinary student. */
export async function activeStudent(t: TestApp, email: string): Promise<Actor> {
  await http(t).post('/auth/register').send(validRegistration(email)).expect(201);
  await http(t)
    .post('/auth/activate')
    .send({ token: t.mailbox.latestFor(email)!.token })
    .expect(200);
  return login(t, email);
}

/** The shared bootstrap secret (`ADMIN_SEED_PASSWORD` in vitest.config.mts); never usable to sign in. */
export const BOOTSTRAP_PASSWORD = 'bootstrap-secret-from-config';

/** Replaces a password through the real endpoint. */
export function changePassword(
  t: TestApp,
  email: string,
  currentPassword: string,
  newPassword: string,
) {
  return http(t)
    .post('/auth/password')
    .set('Origin', ORIGIN)
    .send({ email, currentPassword, newPassword });
}

/** Re-enters the password on the actor's session (`POST /auth/step-up`, ADR 0008). */
export async function stepUp(t: TestApp, actor: Actor, password = PASSWORD): Promise<Actor> {
  await http(t)
    .post('/auth/step-up')
    .set('Authorization', bearer(actor))
    .send({ password })
    .expect(204);
  return actor;
}

/**
 * Creates a seeded administrator through the real seeding path, replaces the bootstrap password
 * as the first sign-in requires, then logs in with {@link PASSWORD}. The session has re-entered
 * its password, as an admin about to change roles would have; pass `stepUp: false` for one that
 * has not.
 */
export async function seededAdmin(
  t: TestApp,
  email: string,
  options: { stepUp?: boolean } = {},
): Promise<Actor> {
  await seedAdmins(t.orm, {
    emails: [email],
    password: BOOTSTRAP_PASSWORD,
    allowedDomains: ['u.nus.edu'],
  });
  await changePassword(t, email, BOOTSTRAP_PASSWORD, PASSWORD).expect(204);
  const actor = await login(t, email);
  return options.stepUp === false ? actor : stepUp(t, actor);
}

export const bearer = (a: Pick<Actor, 'accessToken'>) => `Bearer ${a.accessToken}`;

export const TRUNCATE_ALL =
  'TRUNCATE outbox_events, audit_records, role_change_requests, admin_reads, admin_alerts, activation_tokens, refresh_sessions, profiles, user_roles, users RESTART IDENTITY CASCADE';
