import { createTransport } from 'nodemailer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedAdmins } from '../src/admin/seed.js';
import { RateLimiter } from '../src/auth/rate-limiter.js';
import { sha256Hex } from '../src/auth/tokens.js';
import { SmtpMailer } from '../src/mail/smtp-mailer.js';
import {
  activation,
  createTestApp,
  openLimiters,
  validRegistration,
  type TestApp,
} from './helpers/app.js';
import {
  BOOTSTRAP_PASSWORD,
  ORIGIN,
  PASSWORD,
  TRUNCATE_ALL,
  bearer,
  http as httpOf,
  login,
} from './helpers/actors.js';

/**
 * #309 — password reset by email. The pre-registration hijack itself is closed by choosing the
 * password at activation (registration.test.ts); a reset is how the inbox's owner takes back an
 * account whatever its password.
 */
let t: TestApp;
const http = () => httpOf(t);
const EMAIL = 'e0123456@u.nus.edu';
const NEW_PASSWORD = 'the-students-own-passphrase';
const REQUESTED = {
  message: 'If that address has an account, a link to reset its password is on its way.',
};

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await t.db.exec(TRUNCATE_ALL);
});

const register = (email = EMAIL) =>
  http().post('/auth/register').send(validRegistration(email)).expect(201);
const activate = (token: string, password = PASSWORD) =>
  http().post('/auth/activate').send(activation(token, password));
const activeAccount = async (email = EMAIL) => {
  await register(email);
  await activate(t.mailbox.latestFor(email)!.token).expect(200);
};
const requestReset = (email: string) => http().post('/auth/password-reset').send({ email });
const confirm = (token: string, password = NEW_PASSWORD) =>
  http().post('/auth/password-reset/confirm').send({ token, password });
const signIn = (password: string, email = EMAIL) =>
  http().post('/auth/login').set('Origin', ORIGIN).send({ email, password });
const resetTokenFor = (email = EMAIL) => t.mailbox.latestResetFor(email)?.token;
/** The request answers before it mails, so wait for a reset email newer than `previous`. */
const resetLink = async (email = EMAIL, previous?: string) => {
  await requestReset(email).expect(202, REQUESTED);
  await vi.waitFor(() => expect(resetTokenFor(email)).toBeDefined());
  await vi.waitFor(() => expect(resetTokenFor(email)).not.toBe(previous));
  return resetTokenFor(email)!;
};
const status = async () => (await t.db.query('SELECT status FROM users')).rows[0]!.status;
const activatedEvents = async () =>
  (await t.db.query("SELECT payload FROM outbox_events WHERE event_type = 'user.activated'")).rows;

describe('POST /auth/password-reset', () => {
  it('answers a known and an unknown address the same way, and mails only the known one', async () => {
    await activeAccount();
    const send = vi.spyOn(t.mailbox, 'sendPasswordReset');

    const known = await requestReset(EMAIL).expect(202);
    const unknown = await requestReset('nobody@u.nus.edu').expect(202);
    const offDomain = await requestReset('alex@gmail.com').expect(202);

    expect(unknown.body).toEqual(known.body);
    expect(offDomain.body).toEqual(known.body);
    expect(known.body).toEqual(REQUESTED);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    // Give a background send the chance to happen, so "only once" is not just "not yet".
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({ to: EMAIL });
  });

  it('mails an account still waiting for activation, but not a suspended one', async () => {
    await register();
    await resetLink();

    await activeAccount('e0999999@u.nus.edu');
    await t.db.query("UPDATE users SET status = 'SUSPENDED' WHERE email = $1", [
      'e0999999@u.nus.edu',
    ]);
    const send = vi.spyOn(t.mailbox, 'sendPasswordReset');
    await requestReset('e0999999@u.nus.edu').expect(202, REQUESTED);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(send).not.toHaveBeenCalled();
  });

  it('stores only a hash of the token, with the configured lifetime', async () => {
    await activeAccount();
    const token = await resetLink();
    const { rows } = await t.db.query(
      'SELECT token_hash, extract(epoch FROM expires_at - now())::int AS ttl FROM password_reset_tokens',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(sha256Hex(token));
    // 30 minutes by default (PASSWORD_RESET_TOKEN_TTL_MINUTES).
    expect(Number(rows[0]!.ttl)).toBeGreaterThan(29 * 60);
    expect(Number(rows[0]!.ttl)).toBeLessThanOrEqual(30 * 60);
  });

  it('rejects a malformed body', async () => {
    await requestReset('not-an-email').expect(422);
    await http().post('/auth/password-reset').send({}).expect(422);
  });

  it('limits per address whether or not it has an account, so a 429 reveals nothing', async () => {
    const limited = await createTestApp({
      db: t.db,
      rateLimiters: { ...openLimiters(), resetPerEmail: new RateLimiter(1, 60_000) },
    });
    try {
      const post = (email: string) => httpOf(limited).post('/auth/password-reset').send({ email });
      await activeAccount();
      for (const email of [EMAIL, 'nobody@u.nus.edu']) {
        await post(email).expect(202);
        const res = await post(` ${email.toUpperCase()} `).expect(429);
        expect(res.body.error.code).toBe('RATE_LIMITED');
        expect(res.headers['retry-after']).toBeDefined();
      }
    } finally {
      await limited.app.close();
    }
  });

  it('limits per client too', async () => {
    const limited = await createTestApp({
      db: t.db,
      rateLimiters: { ...openLimiters(), resetPerIp: new RateLimiter(2, 60_000) },
    });
    try {
      const post = (email: string) => httpOf(limited).post('/auth/password-reset').send({ email });
      await post('a@u.nus.edu').expect(202);
      await post('b@u.nus.edu').expect(202);
      expect((await post('c@u.nus.edu').expect(429)).body.error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.app.close();
    }
  });

  it('keeps its own budget: resending an activation link cannot use up an address’s resets', async () => {
    const limited = await createTestApp({
      db: t.db,
      rateLimiters: {
        ...openLimiters(),
        resendPerEmail: new RateLimiter(1, 60_000),
        resetPerEmail: new RateLimiter(1, 60_000),
      },
    });
    try {
      const post = (path: string) => httpOf(limited).post(path).send({ email: EMAIL });
      await post('/auth/activation/resend').expect(202);
      await post('/auth/activation/resend').expect(429);
      await post('/auth/password-reset').expect(202);
    } finally {
      await limited.app.close();
    }
  });
});

describe('POST /auth/password-reset/confirm', () => {
  it('replaces the password: the old one stops working and the new one signs in', async () => {
    await activeAccount();
    const token = await resetLink();

    await confirm(token).expect(204);

    expect((await signIn(PASSWORD).expect(401)).body.error.code).toBe('INVALID_CREDENTIALS');
    await signIn(NEW_PASSWORD).expect(200);
    // The account was already active: no second activation event.
    expect(await activatedEvents()).toHaveLength(1);
  });

  it('works once', async () => {
    await activeAccount();
    const token = await resetLink();
    await confirm(token).expect(204);

    const again = await confirm(token, 'yet-another-long-passphrase').expect(404);
    expect(again.body.error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');
    await signIn(NEW_PASSWORD).expect(200);
  });

  it('is refused once an ordinary password change has replaced the password', async () => {
    await activeAccount();
    const token = await resetLink();
    await http()
      .post('/auth/password')
      .set('Origin', ORIGIN)
      .send({ email: EMAIL, currentPassword: PASSWORD, newPassword: 'a-changed-long-passphrase' })
      .expect(204);

    const res = await confirm(token).expect(404);
    expect(res.body.error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');
    await signIn('a-changed-long-passphrase').expect(200);
  });

  it('refuses an expired link and changes nothing', async () => {
    await activeAccount();
    const token = await resetLink();
    await t.db.exec("UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'");

    const res = await confirm(token).expect(410);
    expect(res.body.error.code).toBe('PASSWORD_RESET_TOKEN_EXPIRED');
    await signIn(PASSWORD).expect(200);
  });

  it('accepts only the newest link: asking again invalidates the earlier one', async () => {
    await activeAccount();
    const first = await resetLink();
    const second = await resetLink(EMAIL, first);

    expect((await confirm(first).expect(404)).body.error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');
    await confirm(second).expect(204);
  });

  it('refuses an unknown token', async () => {
    const res = await confirm('x'.repeat(43)).expect(404);
    expect(res.body.error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');
  });

  it('applies the registration password policy, and leaves the link usable', async () => {
    await activeAccount();
    const token = await resetLink();

    const short = await confirm(token, 'too-short').expect(422);
    expect(short.body.error.code).toBe('VALIDATION_FAILED');
    expect(short.body.error.details).toEqual([
      expect.objectContaining({ field: 'password', code: 'TOO_SMALL' }),
    ]);
    await confirm(token, 'x'.repeat(129)).expect(422);
    await http().post('/auth/password-reset/confirm').send({ token }).expect(422);
    await http()
      .post('/auth/password-reset/confirm')
      .send({ token: 'short', password: NEW_PASSWORD })
      .expect(422);

    await confirm(token).expect(204);
  });

  it('refuses an account suspended after the link was sent, and leaves the token unused', async () => {
    await activeAccount();
    const token = await resetLink();
    await t.db.exec("UPDATE users SET status = 'SUSPENDED'");

    expect((await confirm(token).expect(404)).body.error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');
    expect(await status()).toBe('SUSPENDED');
    expect(
      (await t.db.query('SELECT consumed_at FROM password_reset_tokens')).rows[0]!.consumed_at,
    ).toBeNull();
  });

  it('ends every session of the account', async () => {
    await activeAccount();
    const session = await login(t, EMAIL);

    await confirm(await resetLink()).expect(204);

    await http().get('/users/me').set('Authorization', bearer(session)).expect(401);
    await http()
      .post('/auth/refresh')
      .set('Cookie', session.cookie)
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .expect(401);
  });

  it('lets a bootstrap administrator replace the bootstrap password, but not choose it again', async () => {
    const admin = 'root@u.nus.edu';
    await seedAdmins(t.orm, {
      emails: [admin],
      password: BOOTSTRAP_PASSWORD,
      allowedDomains: ['u.nus.edu'],
    });
    const token = await resetLink(admin);

    const same = await confirm(token, BOOTSTRAP_PASSWORD).expect(422);
    expect(same.body.error.details).toEqual([
      expect.objectContaining({ field: 'password', code: 'PASSWORD_UNCHANGED' }),
    ]);
    await confirm(token).expect(204);
    await signIn(NEW_PASSWORD, admin).expect(200);
    await signIn(BOOTSTRAP_PASSWORD, admin).expect(401);
  });
});

describe('emailed links on a pending account (#309)', () => {
  it('activates a pending account from a reset link too, and voids its activation link', async () => {
    await register();
    const activationLink = t.mailbox.latestFor(EMAIL)!.token;

    await confirm(await resetLink()).expect(204);

    expect(await status()).toBe('ACTIVE');
    await signIn(NEW_PASSWORD).expect(200);
    // The activation link mailed earlier can no longer choose a password.
    expect((await activate(activationLink).expect(404)).body.error.code).toBe(
      'ACTIVATION_TOKEN_INVALID',
    );
    expect(
      (await t.db.query('SELECT 1 FROM activation_tokens WHERE consumed_at IS NULL')).rows,
    ).toEqual([]);
    // Activated through the reset: exactly one user.activated, so the wallet is still created.
    const events = await activatedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      userId: expect.any(String),
      activatedAt: expect.any(String),
    });
  });

  it('voids a reset link once the account is activated with its own link', async () => {
    await register();
    const activationLink = t.mailbox.latestFor(EMAIL)!.token;
    const reset = await resetLink();

    await activate(activationLink).expect(200);

    expect((await confirm(reset).expect(404)).body.error.code).toBe('PASSWORD_RESET_TOKEN_INVALID');
    await signIn(PASSWORD).expect(200);
    expect(await activatedEvents()).toHaveLength(1);
  });
});

describe('SmtpMailer password reset', () => {
  it('mails a link to the reset page beside the activation page, carrying the token', async () => {
    const transport = createTransport({ jsonTransport: true });
    const sent = vi.spyOn(transport, 'sendMail');
    const mailer = new SmtpMailer(transport, {
      from: 'Friend on Campus <no-reply@foc.local>',
      activationUrl: 'http://localhost:3000/activate',
    });

    await mailer.sendPasswordReset({ to: EMAIL, userId: 'u-1', token: 'abc_DEF-123' });

    const message = JSON.parse(
      ((await sent.mock.results[0]!.value) as { message: string }).message,
    );
    expect(message.to).toEqual([{ address: EMAIL, name: '' }]);
    expect(message.subject).toBe('Reset your Friend on Campus password');
    expect(message.text).toContain('http://localhost:3000/reset-password?token=abc_DEF-123');
  });

  it('builds the same link when the activation page is configured with a trailing slash', async () => {
    const transport = createTransport({ jsonTransport: true });
    const sent = vi.spyOn(transport, 'sendMail');
    const mailer = new SmtpMailer(transport, {
      from: 'Friend on Campus <no-reply@foc.local>',
      activationUrl: 'http://localhost:3000/activate/',
    });

    await mailer.sendPasswordReset({ to: EMAIL, userId: 'u-1', token: 'abc_DEF-123' });

    const message = JSON.parse(
      ((await sent.mock.results[0]!.value) as { message: string }).message,
    );
    expect(message.text).toContain('http://localhost:3000/reset-password?token=abc_DEF-123');
  });
});
