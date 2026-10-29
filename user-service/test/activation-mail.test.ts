import { createTransport } from 'nodemailer';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../src/auth/rate-limiter.js';
import { SmtpMailer } from '../src/mail/smtp-mailer.js';
import { createTestApp, openLimiters, validRegistration, type TestApp } from './helpers/app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const EMAIL = 'e0123456@u.nus.edu';
const RESENT = {
  message: 'If that address has an account waiting for activation, a new link is on its way.',
};

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.exec(
    'TRUNCATE outbox_events, activation_tokens, refresh_sessions, profiles, user_roles, users RESTART IDENTITY CASCADE',
  );
});

const register = (email = EMAIL, overrides: Partial<ReturnType<typeof validRegistration>> = {}) =>
  http()
    .post('/auth/register')
    .send({ ...validRegistration(email), ...overrides });
const tokenFor = (email = EMAIL) => t.mailbox.latestFor(email)?.token;
const expireAll = () =>
  t.db.exec("UPDATE activation_tokens SET expires_at = now() - interval '1 minute'");
const resend = (email: string) => http().post('/auth/activation/resend').send({ email });
/** Resend answers before it mails, so wait for the token in the mailbox to change. */
const nextToken = async (email: string, previous: string | undefined) => {
  await vi.waitFor(() => expect(tokenFor(email)).not.toBe(previous));
  return tokenFor(email)!;
};

describe('SmtpMailer', () => {
  it('mails the recipient a link to the activation page carrying the token', async () => {
    const transport = createTransport({ jsonTransport: true });
    const sent = vi.spyOn(transport, 'sendMail');
    const mailer = new SmtpMailer(transport, {
      from: 'Friend on Campus <no-reply@foc.local>',
      activationUrl: 'http://localhost:3000/activate',
    });

    await mailer.sendActivation({ to: EMAIL, userId: 'u-1', token: 'abc_DEF-123' });

    const message = JSON.parse(
      ((await sent.mock.results[0]!.value) as { message: string }).message,
    );
    expect(message.to).toEqual([{ address: EMAIL, name: '' }]);
    expect(message.from).toEqual({ address: 'no-reply@foc.local', name: 'Friend on Campus' });
    expect(message.text).toContain('http://localhost:3000/activate?token=abc_DEF-123');
  });
});

describe('SmtpMailer.connect', () => {
  const optionsOf = (requireTls: boolean) =>
    (
      SmtpMailer.connect(
        { host: 'smtp.example.org', port: 587, requireTls },
        { from: 'a@foc.local', activationUrl: 'http://localhost:3000/activate' },
      ) as unknown as { transport: { options: Record<string, unknown> } }
    ).transport.options;

  it('refuses a server that will not upgrade to TLS when required, and gives up fast', () => {
    expect(optionsOf(true)).toMatchObject({
      requireTLS: true,
      connectionTimeout: 10_000,
      logger: false,
    });
    expect(optionsOf(false)).toMatchObject({ requireTLS: false });
  });
});

describe('POST /auth/activation/resend', () => {
  it('mails a new link that activates, and the old link stops working', async () => {
    await register().expect(201);
    const first = tokenFor()!;

    expect((await resend(EMAIL).expect(202)).body).toEqual(RESENT);
    const second = await nextToken(EMAIL, first);

    await http().post('/auth/activate').send({ token: first }).expect(404);
    await http().post('/auth/activate').send({ token: second }).expect(200);
  });

  it('replaces an expired link', async () => {
    await register().expect(201);
    const first = tokenFor()!;
    await expireAll();

    await resend(EMAIL).expect(202);
    const second = await nextToken(EMAIL, first);
    await http().post('/auth/activate').send({ token: second }).expect(200);
  });

  it('answers an unknown, off-domain or already active address the same way, and mails nothing', async () => {
    await register().expect(201);
    await http().post('/auth/activate').send({ token: tokenFor() }).expect(200);
    const send = vi.spyOn(t.mailbox, 'sendActivation');

    for (const email of [EMAIL, 'nobody@u.nus.edu', 'alex@gmail.com']) {
      expect((await resend(email).expect(202)).body).toEqual(RESENT);
    }
    // Give a background send the chance to happen, so "nothing" is not just "not yet".
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  });

  it('rejects a malformed body', async () => {
    await http().post('/auth/activation/resend').send({ email: 'not-an-email' }).expect(422);
    await http().post('/auth/activation/resend').send({}).expect(422);
  });

  it('limits per address whether or not it has an account, so a 429 reveals nothing', async () => {
    const limited = await createTestApp({
      db: t.db,
      rateLimiters: { ...openLimiters(), resendPerEmail: new RateLimiter(1, 60_000) },
    });
    try {
      const post = (email: string) =>
        request(limited.app.getHttpServer()).post('/auth/activation/resend').send({ email });
      await register().expect(201);
      for (const email of [EMAIL, 'nobody@u.nus.edu']) {
        await post(email).expect(202);
        const res = await post(` ${email.toUpperCase()} `).expect(429);
        expect(res.headers['retry-after']).toBeDefined();
      }
    } finally {
      await limited.app.close();
    }
  });
});

describe('registering again', () => {
  it('reopens an address whose links all expired, with the new password and name', async () => {
    const first = (await register().expect(201)).body.userId;
    await expireAll();

    const again = await register(EMAIL, {
      password: 'a-different-long-passphrase',
      displayName: 'Sam Lee',
    }).expect(201);
    expect(again.body).toEqual({ userId: first, status: 'PENDING_ACTIVATION' });
    expect((await t.db.query('SELECT count(*)::int AS n FROM users')).rows[0]).toEqual({ n: 1 });
    expect((await t.db.query('SELECT display_name FROM profiles')).rows).toEqual([
      { display_name: 'Sam Lee' },
    ]);

    await http().post('/auth/activate').send({ token: tokenFor() }).expect(200);
    await http()
      .post('/auth/login')
      .send({ email: EMAIL, password: 'a-different-long-passphrase' })
      .expect(200);
  });

  it('still refuses an address with a live link, or one that is active', async () => {
    await register().expect(201);
    expect((await register().expect(409)).body.error.code).toBe('EMAIL_ALREADY_REGISTERED');

    await http().post('/auth/activate').send({ token: tokenFor() }).expect(200);
    await expireAll();
    expect((await register().expect(409)).body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });
});

describe('a mail relay that never answers', () => {
  const hang = () =>
    vi.spyOn(t.mailbox, 'sendActivation').mockReturnValue(new Promise<void>(() => {}));
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('does not hold up sign-up', { timeout: 3_000 }, async () => {
    const sent = hang();
    await register().expect(201);
    expect(sent).toHaveBeenCalledOnce();
  });

  it('does not hold up a resend', { timeout: 3_000 }, async () => {
    await register().expect(201);
    const sent = hang();
    await resend(EMAIL).expect(202, RESENT);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
  });
});
