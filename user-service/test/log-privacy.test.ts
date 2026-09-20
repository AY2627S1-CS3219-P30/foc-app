import request from 'supertest';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config.js';
import { UsersModule } from '../src/users/users.module.js';
import { createTestApp, SERVICE_KEY, validRegistration, type TestApp } from './helpers/app.js';

const lines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _enc, cb) {
    lines.push(chunk.toString());
    cb();
  },
});

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ logLevel: 'trace', logDestination: sink });
});
afterAll(async () => {
  await t.close();
});

describe('log privacy (US-NFR2.1.1)', () => {
  it('writes no password, hash or token to any log line at any level', async () => {
    const http = () => request(t.app.getHttpServer());
    const reg = validRegistration();

    const created = await http().post('/auth/register').send(reg).expect(201);
    const token = t.mailbox.latestFor(reg.email)!.token;
    await http().post('/auth/register').send(reg).expect(409); // duplicate path
    await http()
      .post('/auth/register')
      .send({ ...reg, email: 'a@gmail.com' })
      .expect(422);
    await http().post('/auth/activate').send({ token }).expect(200);
    await http().post('/auth/activate').send({ token }).expect(200); // replay path
    await http()
      .post('/auth/activate')
      .send({ token: 'y'.repeat(43) })
      .expect(404);
    await http()
      .get(`/internal/users/${created.body.userId}`)
      .set('x-service-key', SERVICE_KEY)
      .expect(200);
    await http().get(`/internal/users/${created.body.userId}`).expect(401);

    const hash = String(
      (await t.db.query('SELECT password_hash FROM users')).rows[0]!.password_hash,
    );
    const output = lines.join('');
    expect(lines.length).toBeGreaterThan(0); // the capture actually works

    expect(output).not.toContain(reg.password);
    expect(output).not.toContain(token);
    expect(output).not.toContain(hash);
    expect(output).not.toContain(SERVICE_KEY);
    expect(output).not.toMatch(/argon2/i);
  });
});

describe('development mailbox guard', () => {
  it('refuses to start in production, so activation tokens are never exposed there', () => {
    const mutable = env as { NODE_ENV: string };
    const original = mutable.NODE_ENV;
    mutable.NODE_ENV = 'production';
    try {
      expect(() => UsersModule.forRoot()).toThrow(/No production mail adapter/);
    } finally {
      mutable.NODE_ENV = original;
    }
  });
});
