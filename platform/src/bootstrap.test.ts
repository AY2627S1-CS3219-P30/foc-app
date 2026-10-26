import 'reflect-metadata';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Controller, Get, Module, Req, type INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from './bootstrap.js';
import { PlatformModule } from './platform.module.js';

@Controller('internal')
class InternalController {
  @Get('introspect')
  introspect() {
    return { for: 'services only' };
  }

  @Get('orders/:orderId/credit-status')
  status() {
    return { for: 'services only' };
  }
}

@Controller()
class PublicController {
  @Get('.well-known/jwks.json')
  keys() {
    return { keys: [] };
  }

  @Get('whoami')
  whoami(@Req() req: Request) {
    return { ip: req.ip };
  }
}

@Module({
  imports: [
    PlatformModule.forRoot({ serviceName: 'test-service', version: '1', logLevel: 'silent' }),
  ],
  controllers: [InternalController, PublicController],
})
class AppModule {}

/** A port nothing is listening on, for the listener whose number must be known in advance. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe('startService: internal routes on their own port (PL-NFR2.1.2)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(internalPort?: number) {
    app = await NestFactory.create(AppModule, { logger: false });
    await startService(app, {
      serviceName: 'test-service',
      port: 0,
      corsOrigins: 'http://localhost:3000',
      internalPort,
    });
    const { port } = app.getHttpServer().address() as AddressInfo;
    return {
      onPublic: (path: string) => fetch(`http://127.0.0.1:${port}${path}`),
      onInternal: (path: string) => fetch(`http://127.0.0.1:${internalPort}${path}`),
    };
  }

  it('serves an internal route on the public port when no internal port is set', async () => {
    const { onPublic } = await start();
    expect((await onPublic('/internal/introspect')).status).toBe(200);
  });

  it('hides internal routes from the public port and serves them on the internal one', async () => {
    const { onPublic, onInternal } = await start(await freePort());

    const hidden = await onPublic('/internal/introspect');
    expect(hidden.status).toBe(404);
    // The same answer as for a route that does not exist: it does not say there is one.
    const unknown = await onPublic('/internal/no-such-route');
    expect(unknown.status).toBe(404);
    expect(((await hidden.json()) as { error: { code: string } }).error.code).toBe(
      ((await unknown.json()) as { error: { code: string } }).error.code,
    );

    const served = await onInternal('/internal/introspect');
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({ for: 'services only' });
  });

  it.each(['/INTERNAL/introspect', '/internal/introspect/', '/internal/orders/abc/credit-status'])(
    'hides %s too, however the path is written',
    async (path) => {
      const { onPublic, onInternal } = await start(await freePort());

      expect((await onPublic(path)).status).toBe(404);
      expect((await onInternal(path)).status).toBe(200);
    },
  );

  it('still serves public routes on both ports', async () => {
    // A calling service fetches the signing keys from the same address it introspects on.
    const { onPublic, onInternal } = await start(await freePort());

    expect((await onPublic('/.well-known/jwks.json')).status).toBe(200);
    expect((await onInternal('/.well-known/jwks.json')).status).toBe(200);
    expect((await onPublic('/health')).status).toBe(200);
  });

  it('closes both listeners on shutdown', async () => {
    const internalPort = await freePort();
    const { onInternal } = await start(internalPort);
    expect((await onInternal('/health')).status).toBe(200);

    await app!.close();
    app = undefined;

    await expect(onInternal('/health')).rejects.toThrow();
  });

  it('refuses to start with the internal port equal to the public one', async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    const port = await freePort();
    await expect(
      startService(app, {
        serviceName: 'test-service',
        port,
        corsOrigins: 'http://localhost:3000',
        internalPort: port,
      }),
    ).rejects.toThrow('INTERNAL_PORT must differ from PORT');
  });
});

describe('startService: behind the edge (PLT-10)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function ipSeen(trustProxyHops: number | undefined, forwardedFor: string) {
    app = await NestFactory.create(AppModule, { logger: false });
    await startService(app, {
      serviceName: 'test-service',
      port: 0,
      corsOrigins: 'http://localhost:3000',
      trustProxyHops,
    });
    const { port } = app.getHttpServer().address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/whoami`, {
      headers: { 'x-forwarded-for': forwardedFor },
    });
    return ((await response.json()) as { ip: string }).ip;
  }

  it('takes the client address the edge forwards, through one trusted hop', async () => {
    expect(await ipSeen(1, '203.0.113.7')).toBe('203.0.113.7');
  });

  it('ignores a forwarded address when no proxy is trusted, as a service run alone is', async () => {
    expect(await ipSeen(undefined, '203.0.113.7')).not.toBe('203.0.113.7');
  });
});
