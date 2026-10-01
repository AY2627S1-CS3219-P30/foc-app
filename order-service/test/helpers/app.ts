import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AUTHENTICATOR, AuthModule, authFailure, type AuthContext } from '@foc/auth-client';
import { ErrorEnvelopeFilter, PlatformModule } from '@foc/platform';
import { ORDER_DB } from '../../src/db/db.js';
import { OrdersModule } from '../../src/orders/orders.module.js';
import { applyMigrations } from './migrate.js';
import { PgliteDb } from './pglite-db.js';

const identities: Record<string, AuthContext> = {
  requester: {
    userId: 'seed-requester',
    sessionId: 'requester-session',
    displayName: 'Requester',
    roles: ['STUDENT'],
    status: 'ACTIVE',
    isAdmin: false,
  },
  stranger: {
    userId: 'unrelated-student',
    sessionId: 'stranger-session',
    displayName: 'Unrelated Student',
    roles: ['STUDENT'],
    status: 'ACTIVE',
    isAdmin: false,
  },
  admin: {
    userId: 'admin-1',
    sessionId: 'admin-session',
    displayName: 'Admin',
    roles: ['STUDENT', 'ADMIN'],
    status: 'ACTIVE',
    isAdmin: true,
  },
};

const fakeAuthenticator = {
  async authenticate(header: string | undefined): Promise<AuthContext> {
    if (!header) throw authFailure('TOKEN_MISSING');
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!token || !identities[token]) throw authFailure('TOKEN_INVALID');
    return identities[token];
  },
  requireAdmin(context: AuthContext): void {
    if (!context.isAdmin) throw authFailure('FORBIDDEN');
  },
};

export interface TestApp {
  app: INestApplication;
  db: PgliteDb;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const db = await PgliteDb.create();
  await applyMigrations(db);
  const builder = Test.createTestingModule({
    imports: [
      PlatformModule.forRoot({
        serviceName: 'order-service',
        version: 'test',
        logLevel: 'silent',
      }),
      AuthModule.forRoot({
        userServiceUrl: 'http://user-service.test',
        serviceKey: 'test-internal-key-0123456789',
      }),
      OrdersModule.forRoot(),
    ],
  })
    .overrideProvider(ORDER_DB)
    .useValue(db)
    .overrideProvider(AUTHENTICATOR)
    .useValue(fakeAuthenticator);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.init();
  return {
    app,
    db,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export const http = (testApp: TestApp) => request(testApp.app.getHttpServer());
export const asRequester = 'Bearer requester';
export const asStranger = 'Bearer stranger';
export const asAdmin = 'Bearer admin';
