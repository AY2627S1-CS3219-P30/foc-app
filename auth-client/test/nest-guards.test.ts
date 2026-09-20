import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorEnvelopeFilter, PlatformModule } from '@foc/platform';
import {
  AdminOnly,
  AdminOnlyGuard,
  Authenticated,
  AuthModule,
  CurrentUser,
  type AuthContext,
} from '../src/index.js';
import {
  SERVICE_KEY,
  startFakeUserService,
  type FakeUserService,
} from './helpers/fake-user-service.js';

/** A stand-in for Supplier Service: reads for any signed-in user, writes for admins only. */
@Controller('suppliers')
class SuppliersController {
  @Get('open') open() {
    return { public: true };
  }
  @Get() @Authenticated() list(@CurrentUser() user: AuthContext) {
    return { viewer: user.userId, isAdmin: user.isAdmin };
  }
  @Post() @AdminOnly() create(@CurrentUser() user: AuthContext) {
    return { createdBy: user.userId };
  }
  /** Deliberately mis-wired: the admin guard alone, with nothing to establish who the caller is. */
  @Get('misordered') @UseGuards(AdminOnlyGuard) misordered() {
    return { leaked: true };
  }
}

let fake: FakeUserService;
let app: import('@nestjs/common').INestApplication;

beforeAll(async () => {
  fake = await startFakeUserService();
  const mod = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot({ serviceName: 'supplier-service', version: 't', logLevel: 'silent' }),
      AuthModule.forRoot({ userServiceUrl: fake.url, serviceKey: SERVICE_KEY, cacheTtlMs: 0 }),
    ],
    controllers: [SuppliersController],
  }).compile();
  app = mod.createNestApplication();
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.init();
  await app.listen(0);
});
afterAll(async () => {
  await app.close();
  await fake.close();
});

const http = () => request(app.getHttpServer());

describe('a Supplier-style service using only @foc/auth-client', () => {
  it('rejects a student token on the admin route and accepts an admin token', async () => {
    const student = await fake.login();
    const admin = await fake.login({ roles: ['ADMIN', 'STUDENT'] });

    const denied = await http()
      .post('/suppliers')
      .set('Authorization', `Bearer ${student.token}`)
      .expect(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');

    const ok = await http()
      .post('/suppliers')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(201);
    expect(ok.body).toEqual({ createdBy: admin.userId });
  });

  it('lets any signed-in user read, and tells the handler who they are', async () => {
    const student = await fake.login();
    const res = await http()
      .get('/suppliers')
      .set('Authorization', `Bearer ${student.token}`)
      .expect(200);
    expect(res.body).toEqual({ viewer: student.userId, isAdmin: false });
  });

  it('leaves un-decorated routes open', async () => {
    await http().get('/suppliers/open').expect(200);
  });

  it('answers failures in the shared error envelope, with the caller’s correlation id', async () => {
    const res = await http().get('/suppliers').set('x-correlation-id', 'corr-42').expect(401);
    expect(res.body).toEqual({
      error: { code: 'TOKEN_MISSING', message: expect.any(String), correlationId: 'corr-42' },
    });
  });

  it('gives an expired token and a malformed token different codes, both in the envelope', async () => {
    const u = await fake.login();
    const expired = await http()
      .get('/suppliers')
      .set('Authorization', `Bearer ${await fake.mint(u, { expSecondsFromNow: -30 })}`)
      .expect(401);
    const malformed = await http()
      .get('/suppliers')
      .set('Authorization', 'Bearer not.a.jwt')
      .expect(401);
    expect(expired.body.error.code).toBe('TOKEN_EXPIRED');
    expect(malformed.body.error.code).toBe('TOKEN_MALFORMED');
    for (const r of [expired, malformed]) {
      expect(Object.keys(r.body)).toEqual(['error']);
      expect(r.body.error.message).toEqual(expect.any(String));
      expect(r.body.error.correlationId).toEqual(expect.any(String));
    }
  });

  it('reports a revoked session and a suspended account differently', async () => {
    const revoked = await fake.login();
    fake.sessions.get(revoked.sid)!.active = false;
    const suspended = await fake.login({ status: 'SUSPENDED' });
    expect(
      (await http().get('/suppliers').set('Authorization', `Bearer ${revoked.token}`).expect(401))
        .body.error.code,
    ).toBe('TOKEN_REVOKED');
    expect(
      (await http().get('/suppliers').set('Authorization', `Bearer ${suspended.token}`).expect(403))
        .body.error.code,
    ).toBe('ACCOUNT_SUSPENDED');
  });

  it('ignores any role a client claims in a header or body (US-NFR1.1.2)', async () => {
    const student = await fake.login();
    for (const h of ['x-role', 'x-user-role', 'x-roles', 'x-admin', 'role']) {
      await http()
        .post('/suppliers')
        .set('Authorization', `Bearer ${student.token}`)
        .set(h, 'ADMIN')
        .send({ role: 'ADMIN', isAdmin: true })
        .expect(403);
    }
  });

  it('fails closed, as 401, if the admin guard is used without the authentication guard', async () => {
    const admin = await fake.login({ roles: ['ADMIN'] });
    const res = await http()
      .get('/suppliers/misordered')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(401);
    expect(res.body.error.code).toBe('TOKEN_MISSING');
  });

  it('answers 503, not 401, when the User Service is down', async () => {
    const u = await fake.login();
    fake.behaviour.introspectStatus = 500;
    try {
      const res = await http()
        .get('/suppliers')
        .set('Authorization', `Bearer ${u.token}`)
        .expect(503);
      expect(res.body.error.code).toBe('IDENTITY_UNAVAILABLE');
    } finally {
      fake.behaviour.introspectStatus = 200;
    }
  });
});
