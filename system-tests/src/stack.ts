import { fileURLToPath } from 'node:url';
import { OutboxRelay, createEnvelope, type Envelope } from '@foc/platform';
import { createEphemeralPostgres, type EphemeralPostgres } from '@foc/test-harness';
import { CreditTerminalResultsConsumer } from '../../order-service/src/credit-terminal-results.consumer.js';
import { CreditReconciler } from '../../order-service/src/orders/credit-reconciler.js';
import type { CreditStatusReader } from '../../order-service/src/orders/credit-status.client.js';
import { OrdersRepository } from '../../order-service/src/orders/orders.repository.js';
import { ReservationResultsConsumer } from '../../order-service/src/reservation-results.consumer.js';
import { CreditRepository } from '../../credit-service/src/credits/credit.repository.js';
import { ReservationConsumer } from '../../credit-service/src/reservation-consumer.js';
import {
  CompletionConsumer,
  ReleaseConsumer,
} from '../../credit-service/src/terminal-consumers.js';
import { InMemoryBus } from './bus.js';

const migrations = (service: string) =>
  fileURLToPath(new URL(`../../${service}/drizzle`, import.meta.url));
const quietLogger = { log() {}, warn() {}, error() {} };

/**
 * The real Order and Credit code, each on its own freshly migrated PostgreSQL database (database
 * per service, as deployed), wired through the in-memory bus by their own outbox relays and
 * consumers. Nothing is mocked between a service's repository and its database.
 */
export class Stack {
  readonly bus = new InMemoryBus();
  readonly orders: OrdersRepository;
  readonly credits: CreditRepository;
  private readonly relays: OutboxRelay[];

  private constructor(
    readonly orderDb: EphemeralPostgres,
    readonly creditDb: EphemeralPostgres,
  ) {
    this.orders = new OrdersRepository(orderDb.db);
    this.credits = new CreditRepository(creditDb.db);
    this.relays = [this.relay(orderDb, 'order-service'), this.relay(creditDb, 'credit-service')];
  }

  static async start(adminUrl: string, label: string): Promise<Stack> {
    const [orderDb, creditDb] = await Promise.all([
      createEphemeralPostgres({
        adminUrl,
        label: `${label}_order`,
        migrationsFolder: migrations('order-service'),
      }),
      createEphemeralPostgres({
        adminUrl,
        label: `${label}_credit`,
        migrationsFolder: migrations('credit-service'),
      }),
    ]);
    const stack = new Stack(orderDb, creditDb);
    const { consumer } = stack.bus;
    await Promise.all([
      new ReservationResultsConsumer(consumer, orderDb.db, stack.orders).onApplicationBootstrap(),
      new CreditTerminalResultsConsumer(
        consumer,
        orderDb.db,
        stack.orders,
      ).onApplicationBootstrap(),
      new ReservationConsumer(consumer, creditDb.db, stack.credits).onApplicationBootstrap(),
      new CompletionConsumer(consumer, creditDb.db, stack.credits).onApplicationBootstrap(),
      new ReleaseConsumer(consumer, creditDb.db, stack.credits).onApplicationBootstrap(),
    ]);
    // The seeded demonstration order has no Credit counterpart; keep it out of every check.
    await orderDb.db.query(
      `UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL`,
    );
    return stack;
  }

  async stop(): Promise<void> {
    await Promise.all([this.orderDb.dispose(), this.creditDb.dispose()]);
  }

  private relay(database: EphemeralPostgres, producer: string): OutboxRelay {
    return new OutboxRelay({
      db: database.db,
      publisher: {
        publish: async (input) => {
          const envelope = createEnvelope({ ...input, producer });
          this.bus.publish(envelope as Envelope<unknown>);
          return envelope;
        },
      },
      logger: quietLogger,
    });
  }

  /** Relays and delivers until nothing is left in flight in either direction. */
  async settle(maxRounds = 50): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      let moved = 0;
      for (const relay of this.relays) {
        try {
          moved += await relay.tick();
        } catch {
          // The claim rolled back; its rows stay unpublished and the next tick resends them,
          // exactly as the running relay does after a failed poll.
          moved += 1;
        }
      }
      moved += await this.bus.drain();
      if (moved === 0) return;
    }
    throw new Error('the stack did not settle');
  }

  /** Credit's status, read in-process exactly as Order's HTTP client would receive it. */
  readonly creditStatus: CreditStatusReader = {
    status: async (orderId) => {
      const status = await this.credits.orderStatus(orderId);
      return { orderId, status: status.status, detail: status.detail };
    },
  };

  reconciler(options: { staleAfterMs?: number; retryAfterMs?: number } = {}): CreditReconciler {
    return new CreditReconciler(this.orders, this.creditStatus, {
      staleAfterMs: options.staleAfterMs ?? 0,
      retryAfterMs: options.retryAfterMs ?? 300_000,
      intervalMs: 60_000,
    });
  }

  async issueWallet(userId: string): Promise<void> {
    await this.creditDb.db.transaction((tx) => this.credits.issueInitial(tx, userId));
  }

  async wallet(userId: string) {
    const result = await this.creditDb.db.query<{ available: number; reserved: number }>(
      `SELECT available, reserved FROM wallets WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0];
  }

  /** Credit's economic effects for one order: its business transactions by type. */
  async transactionsFor(orderId: string): Promise<string[]> {
    const result = await this.creditDb.db.query<{ transaction_type: string }>(
      `SELECT transaction_type FROM credit_transactions WHERE order_id = $1 ORDER BY occurred_at`,
      [orderId],
    );
    return result.rows.map((row) => row.transaction_type);
  }
}
