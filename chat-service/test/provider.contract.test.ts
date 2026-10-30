import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CORRELATION_HEADER,
  ErrorEnvelopeFilter,
  HEALTH_INDICATORS,
  type HealthIndicator,
} from '@foc/platform';
import { ContractValidator } from '@foc/test-harness';
import { AppModule } from '../src/app.module.js';

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
