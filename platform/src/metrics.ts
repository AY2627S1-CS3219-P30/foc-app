import { Controller, Get, Header, Headers, Inject, Logger } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { ApiException } from './errors.js';

export const METRICS = Symbol('METRICS');
export const METRICS_ACCESS = Symbol('METRICS_ACCESS');

/**
 * Who may read `/metrics`. It holds no personal data, but it lists every route (`/admin/*` and
 * `/internal/*` included) with its error rate, and there is no gateway in front of the services.
 */
export interface MetricsAccess {
  /** When set, a scrape must send `Authorization: Bearer <token>`. */
  token?: string;
  /** Without a token, production refuses every scrape; development and tests stay open. */
  production: boolean;
}

/** Paths that are polled rather than used: counting them would bury real traffic. */
export const UNMEASURED_PATHS: ReadonlySet<string> = new Set(['/health', '/metrics']);

/** Default process metrics (CPU, memory, event-loop lag) are collected once per process. */
let processMetricsCollected = false;

// Local, not logging.ts's: logging.ts imports this module.
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type GaugeSetter<L extends string> = (
  labels: Partial<Record<L, string>>,
  value: number,
) => void;

/**
 * PLT-04 / EI-NFR4.1.2 — the numbers an operator watches, in Prometheus format.
 *
 * One registry per service, labelled with the service's name, and served at `GET /metrics` for
 * Prometheus to scrape. The platform records what every service shares:
 *
 *   - `http_request_duration_seconds`   every request, by method, route pattern and status
 *   - `foc_events_handled_total`        events a consumer handled, with `foc_event_lag_seconds`
 *                                       (from `occurredAt` to handled) and
 *                                       `foc_event_handle_duration_seconds`
 *   - `foc_event_retries_total`         retries scheduled
 *   - `foc_events_dead_lettered_total`  events set aside, by reason
 *   - `foc_events_dropped_total`        events a per-instance queue dropped, by reason
 *   - `foc_outbox_*`                    the outbox relay's throughput and backlog
 *
 * A service adds its own with {@link addGauge}, e.g. the Order Service's errands per status. Queue
 * depths, dead-letter queues included, come from RabbitMQ's own exporter.
 */
export class Metrics {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  readonly eventsHandled: Counter<'queue' | 'event_type'>;
  readonly eventLag: Histogram<'queue' | 'event_type'>;
  readonly eventHandleDuration: Histogram<'queue' | 'event_type'>;
  readonly eventRetries: Counter<'queue' | 'event_type'>;
  readonly eventsDeadLettered: Counter<'queue' | 'reason'>;
  readonly eventsDropped: Counter<'queue' | 'reason'>;
  readonly outboxPublished: Counter;
  readonly outboxFailures: Counter;
  private readonly logger = new Logger(Metrics.name);

  constructor(serviceName: string) {
    this.registry.setDefaultLabels({ service: serviceName });
    if (!processMetricsCollected) {
      // A service is one process. Tests build several apps in one process; only the first
      // registry gets these, so each test app does not start another event-loop monitor.
      processMetricsCollected = true;
      collectDefaultMetrics({ register: this.registry });
    }
    const registers = [this.registry];

    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Time to answer an HTTP request, by method, route pattern and status code.',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    this.eventsHandled = new Counter({
      name: 'foc_events_handled_total',
      help: 'Events a consumer handled successfully.',
      labelNames: ['queue', 'event_type'],
      registers,
    });
    this.eventLag = new Histogram({
      name: 'foc_event_lag_seconds',
      help: 'Time from an event occurring to its consumer handling it, retries included.',
      labelNames: ['queue', 'event_type'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 60, 300, 900],
      registers,
    });
    this.eventHandleDuration = new Histogram({
      name: 'foc_event_handle_duration_seconds',
      help: 'Time a consumer spent handling one event.',
      labelNames: ['queue', 'event_type'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers,
    });
    this.eventRetries = new Counter({
      name: 'foc_event_retries_total',
      help: 'Retries scheduled after a handler failed.',
      labelNames: ['queue', 'event_type'],
      registers,
    });
    this.eventsDeadLettered = new Counter({
      name: 'foc_events_dead_lettered_total',
      help: 'Events moved to a dead-letter queue: unparseable at once, or after every attempt failed.',
      labelNames: ['queue', 'reason'],
      registers,
    });
    this.eventsDropped = new Counter({
      name: 'foc_events_dropped_total',
      help: 'Events a private per-instance queue dropped (it has no retry or dead-letter queue): unparseable, or the handler failed.',
      labelNames: ['queue', 'reason'],
      registers,
    });
    this.outboxPublished = new Counter({
      name: 'foc_outbox_published_total',
      help: 'Outbox rows the broker confirmed.',
      registers,
    });
    this.outboxFailures = new Counter({
      name: 'foc_outbox_publish_failures_total',
      help: 'Failed attempts to publish an outbox row; the row is retried after a backoff.',
      registers,
    });
  }

  /** Records one answered request. `route` is the matched pattern, never the raw path. */
  observeHttp(method: string, route: string, status: number, seconds: number): void {
    this.httpDuration.observe({ method, route, status: String(status) }, seconds);
  }

  /**
   * A gauge read when Prometheus scrapes, such as a count from the service's database. `collect`
   * sets every series it wants reported; series it does not set this time disappear.
   *
   * A `collect` that throws (the database is down, say) logs a warning rather than failing the
   * whole scrape, which would mark the service itself as down. The gauge then reports nothing, or
   * NaN if it has no labels: such a gauge always has a value, and 0 would be a lie.
   */
  addGauge<L extends string>(options: {
    name: string;
    help: string;
    labelNames?: readonly L[];
    collect: (set: GaugeSetter<L>) => Promise<void> | void;
  }): void {
    const { collect, name } = options;
    const labelled = (options.labelNames ?? []).length > 0;
    const logger = this.logger;
    new Gauge<L>({
      name: options.name,
      help: options.help,
      labelNames: options.labelNames ?? [],
      registers: [this.registry],
      async collect() {
        this.reset();
        try {
          await collect((labels, value) => this.set(labels, value));
        } catch (err) {
          this.reset();
          if (!labelled) this.set(Number.NaN);
          logger.warn({ metric: name, reason: errorMessage(err), msg: 'metric not collected' });
        }
      },
    });
  }

  /** The registry in Prometheus text format. */
  render(): Promise<string> {
    return this.registry.metrics();
  }
}

/** `GET /metrics` for Prometheus, behind the scrape token (`METRICS_TOKEN`). */
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(METRICS_ACCESS) private readonly access: MetricsAccess,
  ) {}

  @Get()
  @Header('Content-Type', Registry.PROMETHEUS_CONTENT_TYPE)
  @Header('Cache-Control', 'no-store')
  async scrape(@Headers('authorization') authorization?: string): Promise<string> {
    if (!mayScrape(this.access, authorization)) {
      throw new ApiException(401, 'UNAUTHENTICATED', 'Metrics need the scrape token.');
    }
    return this.metrics.render();
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Compares digests in constant time, so neither the token nor its length leaks through timing. */
function mayScrape(access: MetricsAccess, authorization: string | undefined): boolean {
  if (!access.token) return !access.production;
  const presented = /^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? '';
  return timingSafeEqual(digest(presented), digest(access.token));
}
