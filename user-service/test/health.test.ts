import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORRELATION_HEADER, ErrorEnvelopeFilter } from '@foc/platform';
import { AppModule } from '../src/app.module.js';

describe('user-service', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ErrorEnvelopeFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('answers GET /health with 200 and its own identifier', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('user-service');
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });

  it('echoes an inbound correlation ID', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .set(CORRELATION_HEADER, 'test-correlation-1')
      .expect(200);
    expect(res.headers[CORRELATION_HEADER]).toBe('test-correlation-1');
  });

  it('mints a correlation ID when the caller sends none', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.headers[CORRELATION_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the shared error envelope on an unknown route', async () => {
    const res = await request(app.getHttpServer()).get('/does-not-exist').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.correlationId).toBeTruthy();
  });
});
