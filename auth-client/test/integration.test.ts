import { Controller, Get, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorEnvelopeFilter, PlatformModule } from '@foc/platform';
import {
  AdminOnly,
  Authenticated,
  AuthModule,
  CurrentUser,
  type AuthContext,
} from '../src/index.js';
// The real User Service, in-process, on a real port — reached over HTTP like any other service would.
import {
  createTestApp,
  SERVICE_KEY as USER_SERVICE_KEY,
  type TestApp,
} from '../../user-service/test/helpers/app.js';
import {
  activeStudent,
  bearer,
  http as userHttp,
  login,
  ORIGIN,
  seededAdmin,
  TRUNCATE_ALL,
  type Actor,
} from '../../user-service/test/helpers/actors.js';

@Controller('suppliers')
class SuppliersController {
  @Get() @Authenticated() list(@CurrentUser() user: AuthContext) {
    return { viewer: user.userId };
  }
  @Post() @AdminOnly() create(@CurrentUser() user: AuthContext) {
    return { createdBy: user.userId };
  }
}

let users: TestApp;
let supplier: import('@nestjs/common').INestApplication;
let supplierWindow: import('@nestjs/common').INestApplication;
let clock = 0;
let admin: Actor;
let student: Actor;

async function supplierApp(cacheTtlMs: number, now?: () => number) {
  const userServiceUrl = (await users.app.getUrl()).replace('[::1]', '127.0.0.1');
  const mod = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot({ serviceName: 'supplier-service', version: 't', logLevel: 'silent' }),
      AuthModule.forRoot({ userServiceUrl, serviceKey: USER_SERVICE_KEY, cacheTtlMs, now }),
    ],
    controllers: [SuppliersController],
  }).compile();
  const app = mod.createNestApplication();
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.init();
  await app.listen(0);
  return app;
}
const call = (
  app: import('@nestjs/common').INestApplication,
  method: 'get' | 'post',
  token: string,
) => request(app.getHttpServer())[method]('/suppliers').set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  users = await createTestApp();
  await users.db.exec(TRUNCATE_ALL);
  admin = await seededAdmin(users, 'root@u.nus.edu');
  student = await activeStudent(users, 'student@u.nus.edu');
  supplier = await supplierApp(0); // check the User Service on every request
  supplierWindow = await supplierApp(5_000, () => clock); // the production default, with a controllable clock
});
afterAll(async () => {
  await supplier.close();
  await supplierWindow.close();
  await users.close();
});

describe('a Supplier-style service against the REAL User Service', () => {
  it('rejects a real student token and accepts a real admin token on the admin route', async () => {
    const denied = await call(supplier, 'post', student.accessToken).expect(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    const ok = await call(supplier, 'post', admin.accessToken).expect(201);
    expect(ok.body.createdBy).toBe(admin.id);
    await call(supplier, 'get', student.accessToken).expect(200);
  });

  it('turns away a token the User Service never issued', async () => {
    const [h, , s] = admin.accessToken.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: student.id, sid: 'x', iss: 'foc-user-service', exp: 9999999999 }),
    ).toString('base64url');
    expect((await call(supplier, 'get', `${h}.${forged}.${s}`).expect(401)).body.error.code).toBe(
      'TOKEN_INVALID',
    );
    expect((await call(supplier, 'get', 'garbage').expect(401)).body.error.code).toBe(
      'TOKEN_MALFORMED',
    );
  });

  it('a logout at the User Service ends access here (TOKEN_REVOKED)', async () => {
    const s = await login(users, 'student@u.nus.edu');
    await call(supplier, 'get', s.accessToken).expect(200);
    await userHttp(users)
      .post('/auth/logout')
      .set('Cookie', s.cookie)
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .expect(204);
    expect((await call(supplier, 'get', s.accessToken).expect(401)).body.error.code).toBe(
      'TOKEN_REVOKED',
    );
  });

  it('a suspension at the User Service ends access here, and reactivation plus a new login restores it', async () => {
    const s = await login(users, 'student@u.nus.edu');
    await call(supplier, 'get', s.accessToken).expect(200);

    await userHttp(users)
      .post(`/admin/users/${s.id}/suspend`)
      .set('Authorization', bearer(admin))
      .send({ reason: 'integration' })
      .expect(200);
    expect((await call(supplier, 'get', s.accessToken).expect(401)).body.error.code).toBe(
      'TOKEN_REVOKED',
    );

    await userHttp(users)
      .post(`/admin/users/${s.id}/reactivate`)
      .set('Authorization', bearer(admin))
      .send({ reason: 'integration' })
      .expect(200);
    const again = await login(users, 'student@u.nus.edu');
    await call(supplier, 'get', again.accessToken).expect(200);
  });

  it('a demotion at the User Service takes an admin’s write access away here', async () => {
    await userHttp(users)
      .put(`/admin/users/${student.id}/role`)
      .set('Authorization', bearer(admin))
      .send({ role: 'ADMIN', reason: 'integration' })
      .expect(200);
    const promoted = await login(users, 'student@u.nus.edu');
    await call(supplier, 'post', promoted.accessToken).expect(201);

    await userHttp(users)
      .put(`/admin/users/${student.id}/role`)
      .set('Authorization', bearer(admin))
      .send({ role: 'STUDENT', reason: 'integration' })
      .expect(200);
    await call(supplier, 'post', promoted.accessToken).expect(403);
  });
});

describe('the documented staleness window, with the production default (5 s)', () => {
  it('a suspension is enforced no later than the window, and the answer is reused inside it', async () => {
    clock = 1_000_000;
    const s = await login(users, 'student@u.nus.edu');
    await call(supplierWindow, 'get', s.accessToken).expect(200); // now cached

    await userHttp(users)
      .post(`/admin/users/${s.id}/suspend`)
      .set('Authorization', bearer(admin))
      .send({ reason: 'window' })
      .expect(200);

    clock += 4_999;
    await call(supplierWindow, 'get', s.accessToken).expect(200); // still inside the stale window
    clock += 2;
    expect((await call(supplierWindow, 'get', s.accessToken).expect(401)).body.error.code).toBe(
      'TOKEN_REVOKED',
    ); // 5 s: well under the 10 s the ticket allows

    await userHttp(users)
      .post(`/admin/users/${s.id}/reactivate`)
      .set('Authorization', bearer(admin))
      .send({ reason: 'window' })
      .expect(200);
  });
});
