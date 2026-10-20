import { Controller, Get, HttpStatus, Inject, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import { errorMessage } from './logging.js';

export const SERVICE_INFO = Symbol('SERVICE_INFO');
export const HEALTH_INDICATORS = Symbol('HEALTH_INDICATORS');

export interface ServiceInfo {
  name: string;
  version: string;
}

/**
 * Something a service depends on that `GET /health` asks about. Any provider with a `checkHealth`
 * method is found and asked (see `PlatformModule`); `PgDb` and `BrokerConnection` are two.
 */
export interface HealthIndicator {
  /** The key it is reported under, such as `database`. */
  readonly healthName: string;
  /** Whether the service can do its job without it. A mandatory one that fails makes it 503. */
  readonly mandatory: boolean;
  /** Resolves if the dependency answers; rejects, or never settles, if it does not. */
  checkHealth(): Promise<void>;
}

export const isHealthIndicator = (value: unknown): value is HealthIndicator =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as HealthIndicator).checkHealth === 'function' &&
  typeof (value as HealthIndicator).healthName === 'string';

export interface HealthResponse {
  /** `unavailable`, with a 503, while a dependency the service cannot work without is down. */
  status: 'ok' | 'unavailable';
  service: string;
  version: string;
  uptimeSeconds: number;
  /** Each dependency the service declares; absent when it declares none. */
  dependencies?: Record<string, 'up' | 'down'>;
}

/**
 * PL-NFR1.1.1 — every containerized part reports whether it is healthy.
 * PL-NFR3.1.2 — and it is not healthy while a dependency it cannot work without is unavailable.
 *
 * Asks every dependency on each call, so the answer is about now: `503` while the database is
 * gone, `200` again as soon as it is back, with no restart. A dependency the service is built to
 * work without (the broker: the outbox holds events until it returns) is reported as down under
 * `dependencies` and leaves the answer `200 ok`. Why a dependency is down goes to the log, never
 * into the response.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  /** How long one dependency may take to answer before it counts as down. */
  checkTimeoutMs = 2_000;

  constructor(
    @Inject(SERVICE_INFO) private readonly info: ServiceInfo,
    @Inject(HEALTH_INDICATORS) private readonly indicators: () => HealthIndicator[],
  ) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const indicators = this.indicators();
    const results = await Promise.all(indicators.map((indicator) => this.ask(indicator)));

    const dependencies: Record<string, 'up' | 'down'> = {};
    let unavailable = false;
    indicators.forEach((indicator, i) => {
      dependencies[indicator.healthName] = results[i] ? 'up' : 'down';
      if (!results[i] && indicator.mandatory) unavailable = true;
    });

    if (unavailable) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: unavailable ? 'unavailable' : 'ok',
      service: this.info.name,
      version: this.info.version,
      uptimeSeconds: Math.round(process.uptime()),
      ...(indicators.length > 0 ? { dependencies } : {}),
    };
  }

  private async ask(indicator: HealthIndicator): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${this.checkTimeoutMs} ms`)),
        this.checkTimeoutMs,
      );
    });
    try {
      await Promise.race([indicator.checkHealth(), bound]);
      return true;
    } catch (err) {
      this.logger.warn({
        dependency: indicator.healthName,
        reason: errorMessage(err),
        msg: 'health check failed',
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
