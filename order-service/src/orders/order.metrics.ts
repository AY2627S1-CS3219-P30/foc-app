import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { METRICS, type Metrics } from '@foc/platform';
import { ORDER_DB, type OrderDatabase } from '../db/db.js';
import { ORDER_STATUSES } from './types.js';

/**
 * PLT-04 — errands per status, for the operator dashboard. Counted from the database when
 * Prometheus scrapes, so it is the truth at that moment rather than a tally that drifts. Every
 * status is reported, at 0 when no errand is in it, so an emptied status reads 0 rather than
 * vanishing from the panel. One grouped count every 15 s, on orders_status_created_idx.
 */
@Injectable()
export class OrderMetrics implements OnModuleInit {
  constructor(
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(ORDER_DB) private readonly db: OrderDatabase,
  ) {}

  onModuleInit(): void {
    this.metrics.addGauge({
      name: 'foc_orders',
      help: 'Errands per status.',
      labelNames: ['status'],
      collect: async (set) => {
        const { rows } = await this.db.query<{ status: string; n: number }>(
          'SELECT status, count(*)::int AS n FROM orders GROUP BY status',
        );
        const counts = new Map(rows.map(({ status, n }) => [status, n]));
        for (const status of ORDER_STATUSES) set({ status }, counts.get(status) ?? 0);
      },
    });
    // PLT-05 (EI-NFR4.1.2): how long the oldest errand has waited for Credit; 0 when none waits.
    this.metrics.addGauge({
      name: 'foc_orders_pending_credit_oldest_age_seconds',
      help: 'Age of the oldest errand waiting for the Credit Service (PENDING_CREDIT), 0 when none is.',
      collect: async (set) => {
        const { rows } = await this.db.query<{ age: number | null }>(
          `SELECT extract(epoch FROM now() - min(created_at))::float8 AS age
             FROM orders WHERE status = 'PENDING_CREDIT'`,
        );
        set({}, Math.max(0, Number(rows[0]?.age ?? 0)));
      },
    });
  }
}
