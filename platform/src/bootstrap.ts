import { lookup } from 'node:dns/promises';
import { createServer, type Server } from 'node:http';
import {
  INestApplication,
  Logger,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { CORRELATION_HEADER } from './correlation.js';
import { ErrorEnvelopeFilter } from './errors.js';

/** A route under `/internal`, as the router matched it or, failing that, as it was asked for. */
const INTERNAL_ROUTE = /^\/+internal(\/|$)/i;

/**
 * Keeps `/internal/**` off the public port (PL-NFR2.1.2).
 *
 * Those routes are for other services, which reach them on the internal port over the network
 * the services share. The public port is the one published to a browser, and there an internal
 * route answers exactly as a route that does not exist. Decided by the route the router matched,
 * not by reading the URL, so no spelling of the path gets past it. A global guard, so it runs
 * before the route's own service-key guard.
 */
class InternalRoutesGuard implements CanActivate {
  constructor(private readonly internalPort: number) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const route = (req.route as { path?: unknown } | undefined)?.path;
    const matched = typeof route === 'string' ? route : req.path;
    if (INTERNAL_ROUTE.test(matched) && req.socket.localPort !== this.internalPort) {
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    }
    return true;
  }
}

/** `INTERNAL_PORT` as `loadEnv` validated it at boot; unset means one listener, as in `npm run dev`. */
const internalPortFromEnv = (): number | undefined =>
  process.env.INTERNAL_PORT ? Number(process.env.INTERNAL_PORT) : undefined;

/** `TRUSTED_PROXY` as `loadEnv` validated it; unset trusts no proxy. */
const trustedProxyFromEnv = (): string | undefined => process.env.TRUSTED_PROXY || undefined;

/** How often the trusted proxy's name is looked up again: as often as the edge looks up a service. */
const TRUSTED_PROXY_LOOKUP_MS = 10_000;

/**
 * Believes `X-Forwarded-For` from the proxy named `host` alone, and only its last entry: the one
 * the edge wrote. Anyone else, a process on this machine or another container on the network,
 * is taken at its own address whatever it claims. The name is looked up again every 10 s, so an
 * edge that is recreated at a new address is trusted there; until a lookup succeeds (the edge
 * can start after a service), nobody is.
 */
async function trustOnly(host: string): Promise<{
  trust: (address: string, hop: number) => boolean;
  stop: () => void;
}> {
  let addresses = new Set<string>();
  const refresh = async (): Promise<void> => {
    try {
      addresses = new Set((await lookup(host, { all: true })).map((found) => found.address));
    } catch {
      // Not resolvable for now: keep the addresses last found.
    }
  };
  await refresh();
  const timer = setInterval(() => void refresh(), TRUSTED_PROXY_LOOKUP_MS);
  timer.unref();
  return {
    // Hop 0 is the connection itself; believing it moves `req.ip` to the edge's entry, and no further.
    trust: (address, hop) => hop === 0 && addresses.has(address.replace(/^::ffff:/, '')),
    stop: () => clearInterval(timer),
  };
}

/**
 * Applies the conventions every service shares and starts listening.
 *
 * Graceful shutdown is wired here rather than per service: on SIGTERM the app
 * stops accepting connections and lets in-flight requests finish, so a
 * `docker compose restart` does not sever a request mid-write.
 *
 * With an internal port (`INTERNAL_PORT`, set per container by Compose) the
 * service listens twice. The public port serves everything except
 * `/internal/**`; the internal port, which Compose does not publish, serves
 * everything. Without one there is a single listener and `/internal/**` is on
 * it, guarded by the service key alone: that is `npm run dev`, not a deployment.
 */
export async function startService(
  app: INestApplication,
  options: {
    serviceName: string;
    port: number;
    corsOrigins: string;
    /** Defaults to `INTERNAL_PORT` from the environment. */
    internalPort?: number;
    /** The proxy to believe about the client's address, by name. Defaults to `TRUSTED_PROXY`. */
    trustedProxy?: string;
  },
): Promise<void> {
  const logger = new Logger(options.serviceName);
  const internalPort = options.internalPort ?? internalPortFromEnv();
  if (internalPort !== undefined && internalPort === options.port) {
    throw new Error('INTERNAL_PORT must differ from PORT: it is the port that is not published.');
  }

  // Behind the edge a browser's request comes from the edge; it forwards the address it saw, so
  // `req.ip` is the client's and per-address limits count clients (PLT-10, ADR 0010).
  const trustedProxy = options.trustedProxy ?? trustedProxyFromEnv();
  if (trustedProxy) {
    const { trust, stop } = await trustOnly(trustedProxy);
    (app.getHttpAdapter().getInstance() as { set(name: string, value: unknown): void }).set(
      'trust proxy',
      trust,
    );
    (app.getHttpServer() as Server).once('close', stop);
  }

  app.useGlobalFilters(new ErrorEnvelopeFilter());
  if (internalPort !== undefined) app.useGlobalGuards(new InternalRoutesGuard(internalPort));
  app.enableShutdownHooks();

  // The browser talks to each service on its own origin, so every service
  // needs CORS. An explicit allowlist, never '*' — these endpoints carry
  // credentials once USR-02 lands.
  const origins = options.corsOrigins
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins,
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'If-Match',
      'Idempotency-Key',
      CORRELATION_HEADER,
    ],
    exposedHeaders: ['ETag', 'Retry-After', CORRELATION_HEADER],
  });
  logger.log(`CORS allows: ${origins.join(', ')}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`Received ${signal}, shutting down`);
    try {
      await app.close();
      logger.log('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen(options.port, '0.0.0.0');
  logger.log(`${options.serviceName} listening on port ${options.port}`);

  if (internalPort !== undefined) {
    // The same application on a second socket; the guard tells the two apart by local port.
    const internal: Server = createServer(app.getHttpAdapter().getInstance());
    await new Promise<void>((resolve, reject) => {
      internal.once('error', reject);
      internal.listen(internalPort, '0.0.0.0', () => resolve());
    });
    // Goes down with the public listener, however the application is closed.
    (app.getHttpServer() as Server).once('close', () => {
      internal.close();
      internal.closeAllConnections();
    });
    logger.log(`${options.serviceName} serves /internal/** on port ${internalPort} only`);
  }
}
