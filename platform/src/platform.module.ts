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

export const LOGGER = Symbol('LOGGER');

export interface PlatformModuleOptions {
  serviceName: string;
  version: string;
  logLevel: string;
  /** Where log lines go. Defaults to stdout; a test passes a stream to inspect them. */
  logDestination?: DestinationStream;
}

/**
 * Everything a FoC service gets for free: structured JSON logging with a
 * correlation ID on every line, request logging, and a /health endpoint.
 * Imported once per service in its root module.
 */
@Module({})
export class PlatformModule implements NestModule {
  constructor(@Inject(LOGGER) private readonly logger: PinoLogger) {}

  static forRoot(options: PlatformModuleOptions): DynamicModule {
    const info: ServiceInfo = { name: options.serviceName, version: options.version };
    const logger = createLogger(options.serviceName, options.logLevel, options.logDestination);
    return {
      module: PlatformModule,
      controllers: [HealthController],
      providers: [
        { provide: SERVICE_INFO, useValue: info },
        { provide: LOGGER, useValue: logger },
      ],
      exports: [LOGGER],
      global: true,
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestLogger(this.logger)).forRoutes('*splat');
  }
}
