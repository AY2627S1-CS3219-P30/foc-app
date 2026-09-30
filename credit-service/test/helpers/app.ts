import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/pglite';
import request from 'supertest';
import { AUTHENTICATOR, AuthModule, authFailure, type AuthContext } from '@foc/auth-client';
import { ErrorEnvelopeFilter, PlatformModule, type Db } from '@foc/platform';
import { CreditModule } from '../../src/credit.module.js';
import { CreditRepository } from '../../src/credits/credit.repository.js';
import { DB, RAW_DB } from '../../src/db/db.js';
import * as schema from '../../src/db/schema.js';
import { applyMigrations } from './migrate.js';
import { PgliteDb } from './pglite-db.js';

const identities: Record<string, AuthContext> = {
  student: {
    userId: 'student-1',
    sessionId: 'session-student',
    displayName: 'Student One',
    roles: ['STUDENT'],
    status: 'ACTIVE',
    isAdmin: false,
  },
  other: {
    userId: 'student-2',
    sessionId: 'session-other',
    displayName: 'Student Two',
    roles: ['STUDENT'],
    status: 'ACTIVE',
    isAdmin: false,
  },
  admin: {
    userId: 'admin-1',
    sessionId: 'session-admin',
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
  db: Db;
  credits: CreditRepository;
  close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
  const db = await PgliteDb.create();
  await applyMigrations(db);
  const builder = Test.createTestingModule({
    imports: [
      PlatformModule.forRoot({
        serviceName: 'credit-service',
        version: 'test',
        logLevel: 'silent',
      }),
      AuthModule.forRoot({
        userServiceUrl: 'http://user-service.test',
        serviceKey: 'test-internal-key-0123456789',
      }),
      CreditModule.forRoot(),
    ],
  })
    .overrideProvider(RAW_DB)
    .useValue(db)
    .overrideProvider(DB)
    .useValue(drizzle(db.client, { schema }))
    .overrideProvider(AUTHENTICATOR)
    .useValue(fakeAuthenticator);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.init();
  await app.listen(0);
  return {
    app,
    db,
    credits: moduleRef.get(CreditRepository),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export const http = (testApp: TestApp) => request(testApp.app.getHttpServer());
export const asStudent = 'Bearer student';
export const asOther = 'Bearer other';
export const asAdmin = 'Bearer admin';

export async function issue(testApp: TestApp, userId: string): Promise<void> {
  await testApp.db.transaction((tx) => testApp.credits.issueInitial(tx, userId));
}
