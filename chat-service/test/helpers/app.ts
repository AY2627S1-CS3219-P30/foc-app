import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AUTHENTICATOR, AuthModule, authFailure, type AuthContext } from '@foc/auth-client';
import { ErrorEnvelopeFilter, PlatformModule } from '@foc/platform';
import { ChatModule } from '../../src/chat/chat.module.js';
import { UPSTREAM_FETCH, type OrderForChat } from '../../src/chat/upstreams.js';
import { CHAT_DB } from '../../src/db/db.js';
import { applyMigrations } from './migrate.js';
import { PgliteDb } from './pglite-db.js';

/** The people in these tests. The bearer token names one; the identity is resolved from it. */
export const PEOPLE = {
  requester: { userId: 'user-requester', displayName: 'Rae Requester' },
  courier: { userId: 'user-courier', displayName: 'Cy Courier' },
  replacement: { userId: 'user-replacement', displayName: 'Rio Replacement' },
  stranger: { userId: 'user-stranger', displayName: 'Sam Stranger' },
  admin: { userId: 'user-admin', displayName: 'Ada Admin' },
} as const;
export type Person = keyof typeof PEOPLE;
export const as = (person: Person) => `Bearer ${person}`;

const fakeAuthenticator = {
  async authenticate(header: string | undefined): Promise<AuthContext> {
    const person = /^Bearer (\w+)$/.exec(header ?? '')?.[1] as Person | undefined;
    if (!person || !(person in PEOPLE)) throw authFailure('TOKEN_MISSING');
    const isAdmin = person === 'admin';
    return {
      ...PEOPLE[person],
      sessionId: randomUUID(),
      roles: isAdmin ? ['ADMIN', 'STUDENT'] : ['STUDENT'],
      status: 'ACTIVE',
      isAdmin,
    };
  },
  requireAdmin(context: AuthContext): void {
    if (!context.isAdmin) throw authFailure('FORBIDDEN');
  },
};

/**
 * Stand-ins for the Order and User Services, behind the one fetch chat calls them with. Each
 * errand is set by the test; `down` makes both stop answering.
 */
export class FakeUpstreams {
  readonly errands = new Map<string, OrderForChat>();
  readonly calls: { method: string; url: string }[] = [];
  down = false;

  /** An errand of the requester's, accepted by the courier unless said otherwise. */
  errand(overrides: Partial<OrderForChat> = {}): string {
    const orderId = randomUUID();
    this.errands.set(orderId, {
      status: 'ACCEPTED',
      version: 3,
      requesterId: PEOPLE.requester.userId,
      courierId: PEOPLE.courier.userId,
      endedAt: null,
      ...overrides,
    });
    return orderId;
  }

  update(orderId: string, changes: Partial<OrderForChat>): void {
    this.errands.set(orderId, { ...this.errands.get(orderId)!, ...changes });
  }

  readonly fetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    this.calls.push({ method: init?.method ?? 'GET', url: url.href });
    if (this.down) throw new TypeError('fetch failed');
    const order = /^\/internal\/orders\/([^/]+)\/chat$/.exec(url.pathname);
    if (order) {
      const errand = this.errands.get(order[1]!);
      return errand ? Response.json(errand) : Response.json({}, { status: 404 });
    }
    const user = /^\/internal\/users\/([^/]+)$/.exec(url.pathname);
    const person = Object.values(PEOPLE).find((p) => p.userId === user?.[1]);
    return Response.json(
      person ? { userId: person.userId, exists: true, ...person } : { exists: false },
    );
  };
}

export interface TestApp {
  app: INestApplication;
  db: PgliteDb;
  upstreams: FakeUpstreams;
  close(): Promise<void>;
}

/** The real chat modules over a fresh in-memory PostgreSQL with the migrations applied. */
export async function createTestApp(): Promise<TestApp> {
  const db = await PgliteDb.create();
  await applyMigrations(db);
  const upstreams = new FakeUpstreams();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot({ serviceName: 'chat-service', version: 'test', logLevel: 'silent' }),
      AuthModule.forRoot({
        userServiceUrl: 'http://user-service.test',
        serviceKey: 'x'.repeat(16),
      }),
      ChatModule.forRoot(),
    ],
  })
    .overrideProvider(CHAT_DB)
    .useValue(db)
    .overrideProvider(AUTHENTICATOR)
    .useValue(fakeAuthenticator)
    .overrideProvider(UPSTREAM_FETCH)
    .useValue(upstreams.fetch)
    .compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.listen(0, '127.0.0.1');
  return {
    app,
    db,
    upstreams,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export const http = (t: TestApp) => request(t.app.getHttpServer());

/** A message body for `send`, with a fresh clientId unless one is given. */
export const message = (body: string, clientId: string = randomUUID()) => ({ clientId, body });
