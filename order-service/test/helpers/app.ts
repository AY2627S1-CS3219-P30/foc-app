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
import {
  USER_DIRECTORY_FETCH,
  UserDirectoryClient,
} from '../../src/orders/user-directory.client.js';
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

/**
 * A stand-in User Service behind the directory client's fetch: the active administrators (the two
 * admin identities above) and whether it answers at all. Tests change either to suspend an admin
 * or take the service down.
 */
export class FakeUserService {
  readonly admins = new Set(['admin-1', 'admin-2']);
  down = false;
  readonly fetch: typeof fetch = async (input) => {
    if (this.down) throw new TypeError('fetch failed');
    const { pathname } = new URL(String(input));
    if (pathname !== '/internal/admins') return new Response(null, { status: 404 });
    return Response.json({ items: [...this.admins].map((userId) => ({ userId })) });
  };
}

export interface TestApp {
  app: INestApplication;
  db: PgliteDb;
  orders: OrdersRepository;
  orderService: OrdersService;
  directory: UserDirectoryClient;
  userService: FakeUserService;
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
  const userService = new FakeUserService();
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
    .useValue(supplierFetch)
    .overrideProvider(USER_DIRECTORY_FETCH)
    .useValue(userService.fetch);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  // Bound to 127.0.0.1, where supertest connects: left unbound, supertest listens on [::] and can
  // land on a port another local process holds on 127.0.0.1 (macOS allows both) and reach it.
  await app.listen(0, '127.0.0.1');
  return {
    app,
    db,
    orders: moduleRef.get(OrdersRepository),
    orderService: moduleRef.get(OrdersService),
    directory: moduleRef.get(UserDirectoryClient),
    userService,
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
