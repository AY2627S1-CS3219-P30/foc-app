import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AUTHENTICATOR, AuthModule, authFailure, type AuthContext } from '@foc/auth-client';
import { ErrorEnvelopeFilter, PlatformModule, runMigrations } from '@foc/platform';
import { DB, type Db } from '../../src/db/db.js';
import { migrations } from '../../src/db/migrations.js';
import { SuppliersModule } from '../../src/suppliers/suppliers.module.js';
import { PgliteDb } from './pglite-db.js';

/**
 * A stand-in for `@foc/auth-client`'s authenticator. The real one is proven end
 * to end in that package's own suite (against the real User Service); here we
 * only need to drive this service's own logic, so the bearer token IS the role:
 * `Bearer admin` is an administrator, anything else a student, absent is
 * unauthenticated. The role never comes from the client — the guards still read
 * it from this resolved context, exactly as they read the real one.
 */
const fakeAuthenticator = {
  async authenticate(header: string | undefined): Promise<AuthContext> {
    if (!header || header.trim() === '') throw authFailure('TOKEN_MISSING');
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match) throw authFailure('TOKEN_MALFORMED');
    const isAdmin = match[1] === 'admin';
    return {
      userId: isAdmin
        ? '11111111-1111-4111-8111-111111111111'
        : '22222222-2222-4222-8222-222222222222',
      sessionId: '33333333-3333-4333-8333-333333333333',
      displayName: isAdmin ? 'Admin' : 'Student',
      roles: isAdmin ? ['ADMIN', 'STUDENT'] : ['STUDENT'],
      status: 'ACTIVE',
      isAdmin,
    };
  },
  requireAdmin(context: AuthContext): void {
    if (!context.isAdmin) throw authFailure('FORBIDDEN');
  },
};

export interface TestApp {
  app: INestApplication;
  db: Db;
  close(): Promise<void>;
}

/**
 * Boots the real Supplier modules against a fresh in-memory PostgreSQL with migrations applied.
 *
 * By default callers are resolved by {@link fakeAuthenticator}. Pass `auth` to use the real
 * `@foc/auth-client` authenticator against a (fake or real) User Service instead.
 */
export async function createTestApp(
  options: { auth?: { userServiceUrl: string; serviceKey: string } } = {},
): Promise<TestApp> {
  const db = await PgliteDb.create();
  await runMigrations(db, migrations);

  const builder = Test.createTestingModule({
    imports: [
      PlatformModule.forRoot({
        serviceName: 'supplier-service',
        version: 'test',
        logLevel: 'silent',
      }),
      AuthModule.forRoot(
        options.auth
          ? { ...options.auth, cacheTtlMs: 0 }
          : { userServiceUrl: 'http://user-service.test', serviceKey: 'x'.repeat(16) },
      ),
      SuppliersModule.forRoot(),
    ],
  })
    .overrideProvider(DB)
    .useValue(db);
  if (!options.auth) builder.overrideProvider(AUTHENTICATOR).useValue(fakeAuthenticator);
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.init();
  await app.listen(0);

  return {
    app,
    db,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export const http = (t: TestApp) => request(t.app.getHttpServer());
export const asAdmin = 'Bearer admin';
export const asStudent = 'Bearer student';

/** A valid create body; override any field per test. */
export const validSupplier = (over: Record<string, unknown> = {}) => ({
  name: 'Test Kopitiam',
  type: 'FOOD',
  building: 'COM1',
  floor: '1',
  locationDescription: 'Near the entrance',
  openingHours: [{ day: 'MON', opens: '09:00', closes: '18:00' }],
  latitude: 1.2945,
  longitude: 103.7735,
  imageUrl: 'https://example.com/a.jpg',
  tags: ['halal'],
  ...over,
});
