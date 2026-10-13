import {
  DynamicModule,
  Inject,
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import type { DestinationStream, Logger as PinoLogger } from 'pino';
import {
  HEALTH_INDICATORS,
  HealthController,
  SERVICE_INFO,
  isHealthIndicator,
  type HealthIndicator,
  type ServiceInfo,
} from './health.controller.js';
import { baseEnvSchema } from './env.js';
import { createLogger, requestLogger } from './logging.js';
import { METRICS, METRICS_ACCESS, Metrics, MetricsController } from './metrics.js';

export const LOGGER = Symbol('LOGGER');

export interface PlatformModuleOptions {
  serviceName: string;
  version: string;
  logLevel: string;
  /** Where log lines go. Defaults to stdout; a test passes a stream to inspect them. */
  logDestination?: DestinationStream;
  /** The bearer token `GET /metrics` requires. Defaults to `METRICS_TOKEN`. */
  metricsToken?: string;
}

/**
 * `METRICS_TOKEN` from the environment, held to the rule in `baseEnvSchema`. A service has already
 * validated its environment with `loadEnv` by the time it builds this module; this keeps the rule
 * for a module built without that.
 */
function metricsTokenFromEnv(): string | undefined {
  const parsed = baseEnvSchema.shape.METRICS_TOKEN.safeParse(
    process.env.METRICS_TOKEN || undefined,
  );
  if (!parsed.success) throw new Error('METRICS_TOKEN must be at least 16 characters.');
  return parsed.data;
}

/**
 * Everything a FoC service gets for free: structured JSON logging with a
 * correlation ID on every line, request logging, a /health endpoint that asks
 * the service's dependencies, and Prometheus metrics at /metrics. Imported once
 * per service in its root module.
 */
@Module({})
export class PlatformModule implements NestModule {
  constructor(
    @Inject(LOGGER) private readonly logger: PinoLogger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  static forRoot(options: PlatformModuleOptions): DynamicModule {
    const info: ServiceInfo = { name: options.serviceName, version: options.version };
    const logger = createLogger(options.serviceName, options.logLevel, options.logDestination);
    return {
      module: PlatformModule,
      imports: [DiscoveryModule],
      controllers: [HealthController, MetricsController],
      providers: [
        { provide: SERVICE_INFO, useValue: info },
        {
          // Every provider in the application that can report its health (PgDb, the broker
          // connection), found when /health is asked, so a service registers nothing. The same
          // instance under two tokens is asked once.
          provide: HEALTH_INDICATORS,
          useFactory: (discovery: DiscoveryService) => (): HealthIndicator[] => [
            ...new Set(
              discovery
                .getProviders()
                .map((wrapper) => wrapper.instance as unknown)
                .filter(isHealthIndicator),
            ),
          ],
          inject: [DiscoveryService],
        },
        { provide: LOGGER, useValue: logger },
        { provide: METRICS, useValue: new Metrics(options.serviceName) },
        {
          provide: METRICS_ACCESS,
          useValue: {
            token: options.metricsToken ?? metricsTokenFromEnv(),
            production: process.env.NODE_ENV === 'production',
          },
        },
      ],
      exports: [LOGGER, METRICS],
      global: true,
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestLogger(this.logger, this.metrics)).forRoutes('*splat');
  }
}
