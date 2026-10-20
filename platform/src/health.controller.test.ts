import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { HealthController, type HealthIndicator } from './health.controller.js';
import { PlatformModule } from './platform.module.js';

const info = { name: 'test-service', version: '1.2.3' };

/** A response that records the status the controller set; 200 unless it set one. */
function response() {
  let status = 200;
  const res = {
    status(s: number) {
      status = s;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => status };
}

const answering = (healthName: string, mandatory = true): HealthIndicator => ({
  healthName,
  mandatory,
  checkHealth: async () => undefined,
});
const unreachable = (healthName: string, mandatory = true): HealthIndicator => ({
  healthName,
  mandatory,
  checkHealth: async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
  },
});

describe('GET /health (PL-NFR3.1.2)', () => {
  it('is ok with no dependencies', async () => {
    const { res, status } = response();
    const body = await new HealthController(info, () => []).check(res);

    expect(status()).toBe(200);
    expect(body).toMatchObject({ status: 'ok', service: 'test-service', version: '1.2.3' });
    expect(body.dependencies).toBeUndefined();
  });

  it('reports each dependency and is ok when all answer', async () => {
    const { res, status } = response();
    const controller = new HealthController(info, () => [
      answering('database'),
      answering('broker', false),
    ]);

    const body = await controller.check(res);

    expect(status()).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.dependencies).toEqual({ database: 'up', broker: 'up' });
  });

  it('is 503 unavailable when the database does not answer', async () => {
    const { res, status } = response();
    const controller = new HealthController(info, () => [
      unreachable('database'),
      answering('broker', false),
    ]);

    const body = await controller.check(res);

    expect(status()).toBe(503);
    expect(body.status).toBe('unavailable');
    expect(body.dependencies).toEqual({ database: 'down', broker: 'up' });
    // Why it is down is for the log, not for whoever can reach the port.
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });

  it('stays 200 ok, and says the broker is down, when only the broker is', async () => {
    const { res, status } = response();
    const controller = new HealthController(info, () => [
      answering('database'),
      unreachable('broker', false),
    ]);

    const body = await controller.check(res);

    // The outbox holds events until the broker is back, so the service still takes writes.
    expect(status()).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.dependencies).toEqual({ database: 'up', broker: 'down' });
  });

  it('gives up on a dependency that does not answer within its bound', async () => {
    const { res, status } = response();
    const hung: HealthIndicator = {
      healthName: 'database',
      mandatory: true,
      checkHealth: () => new Promise<never>(() => undefined),
    };
    const controller = new HealthController(info, () => [hung]);
    controller.checkTimeoutMs = 20;

    const body = await controller.check(res);

    expect(status()).toBe(503);
    expect(body.dependencies).toEqual({ database: 'down' });
  });

  it('finds the dependencies among the service’s own providers, however they are provided', async () => {
    const database = unreachable('database');
    const broker = answering('broker', false);
    const DB = Symbol('DB');
    const BROKER = Symbol('BROKER');

    @Module({
      providers: [
        { provide: DB, useFactory: () => database },
        // The same instance under a second token must not be asked twice.
        { provide: 'RAW_DB', useExisting: DB },
        { provide: BROKER, useValue: broker },
        { provide: 'UNRELATED', useValue: { name: 'not an indicator' } },
      ],
    })
    class ServiceModule {}

    @Module({
      imports: [
        PlatformModule.forRoot({
          serviceName: 'test-service',
          version: '1.2.3',
          logLevel: 'silent',
        }),
        ServiceModule,
      ],
    })
    class AppModule {}

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
    try {
      const { res, status } = response();
      const body = await app.get(HealthController).check(res);

      expect(status()).toBe(503);
      expect(body.dependencies).toEqual({ database: 'down', broker: 'up' });
    } finally {
      await app.close();
    }
  });
});
