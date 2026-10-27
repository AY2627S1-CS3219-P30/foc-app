import {
  Logger,
  type BeforeApplicationShutdown,
  type FactoryProvider,
  type InjectionToken,
  type LoggerService,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Db } from '../db.js';
import { METRICS, type Metrics } from '../metrics.js';
import { DEFAULT_EVENT_RETENTION, pruneEventTables, type EventRetention } from './retention.js';

export interface EventTablePrunerOptions {
  db: Db;
  /** How long each table keeps its rows. Default {@link DEFAULT_EVENT_RETENTION}. */
  retention?: EventRetention;
  /** How often to prune: right after start, then at this interval. Default 1 h. */
  intervalMs?: number;
  /** Rows deleted per statement. Default 1,000. */
  batchSize?: number;
  logger?: Pick<LoggerService, 'log' | 'warn'>;
  /** Counts what went, as `foc_event_rows_pruned_total{table}`. */
  metrics?: Metrics;
}

/**
 * PLT-12 (#287): keeps a service's event tables from growing for ever, by deleting published
 * outbox rows and inbox rows past their retention ({@link pruneEventTables}).
 *
 * On a timer of its own, apart from the outbox relay: a first prune of a large backlog takes as
 * long as it takes without holding up a single publish, and a service that consumes events but
 * publishes none, or runs without a broker, still prunes. The timer is `unref()`'d, and a service
 * shutting down stops it after the batch in hand. A failure is logged and tried again at the next
 * interval.
 */
export class EventTablePruner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly db: Db;
  private readonly retention: EventRetention;
  private readonly intervalMs: number;
  private readonly batchSize?: number;
  private readonly logger: Pick<LoggerService, 'log' | 'warn'>;
  private readonly metrics?: Metrics;
  private running = false;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private run?: Promise<unknown>;

  constructor(options: EventTablePrunerOptions) {
    this.db = options.db;
    this.retention = options.retention ?? DEFAULT_EVENT_RETENTION;
    this.intervalMs = options.intervalMs ?? 60 * 60_000;
    this.batchSize = options.batchSize;
    this.logger = options.logger ?? new Logger(EventTablePruner.name);
    this.metrics = options.metrics;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.schedule(0);
  }

  /** Stops the timer, and waits for a prune under way to finish the batch in hand. */
  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.run;
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  /** Before the pool closes in its own shutdown hook. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Prunes once, now, and returns what went from each table. Never throws. */
  async prune(): Promise<{ outbox: number; inbox: number }> {
    const pruned = { outbox: 0, inbox: 0 };
    try {
      await pruneEventTables(this.db, this.retention, {
        batchSize: this.batchSize,
        shouldStop: () => this.stopping,
        onDeleted: (table, rows) => {
          pruned[table === 'outbox_events' ? 'outbox' : 'inbox'] += rows;
          this.metrics?.eventRowsPruned.inc({ table }, rows);
        },
      });
      if (pruned.outbox > 0 || pruned.inbox > 0) {
        this.logger.log({ ...pruned, msg: 'event tables pruned' });
      }
    } catch (err) {
      this.logger.warn({
        err,
        ...pruned,
        retryInMs: this.intervalMs,
        msg: 'pruning the event tables failed; will retry',
      });
    }
    return pruned;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.run = this.prune().finally(() => {
        this.run = undefined;
        this.schedule(this.intervalMs);
      });
    }, delayMs);
    this.timer.unref();
  }
}

export const EVENT_TABLE_PRUNER = Symbol('EVENT_TABLE_PRUNER');

/**
 * A Nest provider for a service's {@link EventTablePruner}, given its database's token. Register
 * it whether or not the service has a broker: the tables need pruning either way.
 *
 *   providers: [provideEventTablePruner({ db: ORDER_DB })]
 */
export function provideEventTablePruner(
  options: { db: InjectionToken } & Omit<EventTablePrunerOptions, 'db' | 'metrics'>,
): FactoryProvider<EventTablePruner> {
  const { db, ...rest } = options;
  return {
    provide: EVENT_TABLE_PRUNER,
    useFactory: (database: Db, metrics?: Metrics) =>
      new EventTablePruner({ ...rest, db: database, metrics }),
    inject: [db, { token: METRICS, optional: true }],
  };
}
