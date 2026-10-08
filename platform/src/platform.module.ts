import {
  DynamicModule,
  Inject,
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import type { DestinationStream, Logger as PinoLogger } from 'pino';
import { HealthController, SERVICE_INFO, type ServiceInfo } from './health.controller.js';
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
 * Everything a FoC service gets for free: structured JSON logging with a
 * correlation ID on every line, request logging, a /health endpoint, and
 * Prometheus metrics at /metrics. Imported once per service in its root module.
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
      controllers: [HealthController, MetricsController],
      providers: [
        { provide: SERVICE_INFO, useValue: info },
        { provide: LOGGER, useValue: logger },
        { provide: METRICS, useValue: new Metrics(options.serviceName) },
        {
          provide: METRICS_ACCESS,
          useValue: {
            token: options.metricsToken ?? (process.env.METRICS_TOKEN || undefined),
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
