import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AUTHENTICATOR, AuthModule, authFailure, type AuthContext } from '@foc/auth-client';
import { ErrorEnvelopeFilter, PlatformModule } from '@foc/platform';
import { ORDER_DB } from '../../src/db/db.js';
import { OrdersModule } from '../../src/orders/orders.module.js';
import { OrdersRepository } from '../../src/orders/orders.repository.js';
import { OrdersService } from '../../src/orders/orders.service.js';
import { SUPPLIER_FETCH } from '../../src/orders/supplier.client.js';
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
  bystander: {
    userId: 'bystander-student',
    sessionId: 'bystander-session',
    displayName: 'Bystander Student',
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
  'other-admin': {
    userId: 'admin-2',
    sessionId: 'other-admin-session',
    displayName: 'Other Admin',
    roles: ['STUDENT', 'ADMIN'],
    status: 'ACTIVE',
    isAdmin: true,
  },
  suspended: {
    userId: 'suspended-student',
    sessionId: 'suspended-session',
    displayName: 'Suspended Student',
    roles: ['STUDENT'],
    status: 'SUSPENDED',
    isAdmin: false,
  },
};

const fakeAuthenticator = {
  async authenticate(header: string | undefined): Promise<AuthContext> {
    if (!header) throw authFailure('TOKEN_MISSING');
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!token || !identities[token]) throw authFailure('TOKEN_INVALID');
    const identity = identities[token];
    if (identity.status === 'SUSPENDED') throw authFailure('ACCOUNT_SUSPENDED');
    if (identity.status !== 'ACTIVE') throw authFailure('ACCOUNT_NOT_ACTIVATED');
    return identity;
  },
  requireAdmin(context: AuthContext): void {
    if (!context.isAdmin) throw authFailure('FORBIDDEN');
  },
};

export interface TestApp {
  app: INestApplication;
  db: PgliteDb;
  orders: OrdersRepository;
  orderService: OrdersService;
  close(): Promise<void>;
}

const activeSupplier = {
  supplierId: '00000000-0000-4000-8000-000000000125',
  name: 'The Deck',
  type: 'FOOD',
  building: 'COM2',
  floor: '1',
  locationDescription: 'Level 1 canteen',
  active: true,
};

export async function createTestApp(
  supplierFetch: typeof fetch = async () => Response.json(activeSupplier),
): Promise<TestApp> {
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
    .useValue(fakeAuthenticator)
    .overrideProvider(SUPPLIER_FETCH)
    .useValue(supplierFetch);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.init();
  return {
    app,
    db,
    orders: moduleRef.get(OrdersRepository),
    orderService: moduleRef.get(OrdersService),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export const http = (testApp: TestApp) => request(testApp.app.getHttpServer());
export const asRequester = 'Bearer requester';
export const asStranger = 'Bearer stranger';
export const asBystander = 'Bearer bystander';
export const asAdmin = 'Bearer admin';
export const asOtherAdmin = 'Bearer other-admin';
export const asSuspended = 'Bearer suspended';
