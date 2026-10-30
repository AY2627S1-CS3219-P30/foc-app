import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CORRELATION_HEADER,
  ErrorEnvelopeFilter,
  HEALTH_INDICATORS,
  type HealthIndicator,
} from '@foc/platform';
import { ContractValidator } from '@foc/test-harness';
import { AppModule } from '../src/app.module.js';
import { as, createTestApp, http as httpOf, message, type TestApp } from './helpers/app.js';

/**
 * Provider contract check (TST-01, EI-NFR3.1.1): real responses from the running module must
 * satisfy contracts/chat-service.openapi.yaml. Only /health is served until #162 adds the channels.
 */
describe('chat-service honours its published contract', () => {
  const contract = ContractValidator.for('chat-service');
  let app: INestApplication;
  let dependencies: HealthIndicator[];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ErrorEnvelopeFilter());
    await app.init();
    // /health asks the service's dependencies (PLT-06), and this suite has no database to reach.
    // They answer here; what happens when one does not is tested in @foc/platform.
    dependencies = app.get<() => HealthIndicator[]>(HEALTH_INDICATORS)();
  });

  beforeEach(() => {
    for (const dependency of dependencies) vi.spyOn(dependency, 'checkHealth').mockResolvedValue();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('answers GET /health with 200 and its own identifier', async () => {
    const res = await http().get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'chat-service' });
    expect(res.body.dependencies).toMatchObject({ database: 'up' });
    contract.assert('get', '/health', res);
  });

  it('answers 503 while its database is down', async () => {
    const database = dependencies.find((dependency) => dependency.healthName === 'database')!;
    vi.spyOn(database, 'checkHealth').mockRejectedValue(new Error('connection refused'));
    const res = await http().get('/health');
    expect(res.status).toBe(503);
    contract.assert('get', '/health', res);
  });

  it('echoes an inbound correlation ID, and mints one when the caller sends none', async () => {
    const echoed = await http().get('/health').set(CORRELATION_HEADER, 'test-correlation-1');
    expect(echoed.headers[CORRELATION_HEADER]).toBe('test-correlation-1');
    const minted = await http().get('/health');
    expect(minted.headers[CORRELATION_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the shared error envelope on an unknown route', async () => {
    const res = await http().get('/does-not-exist').set(CORRELATION_HEADER, 'test-correlation-2');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: 'NOT_FOUND',
      correlationId: 'test-correlation-2',
    });
  });
});

describe('chat-service channels honour the contract', () => {
  const contract = ContractValidator.for('chat-service');
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  it('GET /channels/{orderId} (200, 400, 401, 403, 404, 503)', async () => {
    const template = '/channels/{orderId}';
    const get = (id: string, who?: 'requester' | 'stranger') => {
      const req = httpOf(t).get(`/channels/${id}`);
      return who ? req.set('Authorization', as(who)) : req;
    };
    const orderId = t.upstreams.errand();
    contract.assert('get', template, await get(orderId, 'requester'));
    contract.assert('get', template, await get('not-a-uuid', 'requester'));
    contract.assert('get', template, await get(orderId));
    contract.assert('get', template, await get(orderId, 'stranger'));
    contract.assert('get', template, await get(randomUUID(), 'requester'));
    t.upstreams.down = true;
    contract.assert('get', template, await get(orderId, 'requester'));
    t.upstreams.down = false;
  });

  it('POST and GET /channels/{orderId}/messages (201, 200, 200 page, 409, 422)', async () => {
    const template = '/channels/{orderId}/messages';
    const orderId = t.upstreams.errand();
    const post = (body: object) =>
      httpOf(t)
        .post(`/channels/${orderId}/messages`)
        .set('Authorization', as('requester'))
        .send(body);
    const retry = message('on my way');
    contract.assert('post', template, await post(retry));
    contract.assert('post', template, await post(retry));
    contract.assert('post', template, await post({ ...retry, body: 'changed' }));
    contract.assert('post', template, await post({ clientId: 'nope', body: 'hi' }));
    const list = (query: string) =>
      httpOf(t).get(`/channels/${orderId}/messages${query}`).set('Authorization', as('courier'));
    contract.assert('get', template, await list('?after=0'));
    contract.assert('get', template, await list('?after=0&before=2'));
    t.upstreams.update(orderId, { status: 'CANCELLED', endedAt: new Date().toISOString() });
    contract.assert('post', template, await post(message('too late')));
  });

  it('PUT /channels/{orderId}/read (200, 422)', async () => {
    const template = '/channels/{orderId}/read';
    const orderId = t.upstreams.errand();
    const put = (seq: unknown) =>
      httpOf(t)
        .put(`/channels/${orderId}/read`)
        .set('Authorization', as('requester'))
        .send({ seq });
    contract.assert('put', template, await put(0));
    contract.assert('put', template, await put(5));
    expect((await put(0)).status).toBe(200);
  });
});
