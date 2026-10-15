import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Db, Row } from '@foc/platform';
import { RAW_DB } from '../db/db.js';

/** Distinct wallets one admin may read in an hour before BULK_WALLET_READS is raised. */
export const WALLET_READS_ALERT_PER_HOUR = Symbol('WALLET_READS_ALERT_PER_HOUR');

const KIND = 'BULK_WALLET_READS';

/**
 * ADM-04 (ADR 0008) — watching the admins on this side: every admin wallet read is already
 * recorded (`admin_wallet_reads`); one admin reading many wallets in an hour raises an alert, as
 * the User Service does for accounts. Counted in distinct wallets, since opening one wallet reads
 * its balance and its ledger.
 */
@Injectable()
export class AdminActivity {
  private readonly logger = new Logger(AdminActivity.name);

  constructor(
    @Inject(RAW_DB) private readonly db: Db,
    @Inject(WALLET_READS_ALERT_PER_HOUR) private readonly threshold: number,
  ) {}

  /**
   * After a recorded read: at the threshold, raises BULK_WALLET_READS, at most once per admin per
   * hour. The check and the insert hold an advisory lock, so simultaneous reads raise it once.
   */
  async afterWalletRead(adminUserId: string): Promise<void> {
    const { rows } = await this.db.query<{ n: number } & Row>(
      `SELECT count(DISTINCT target_user_id)::int AS n FROM admin_wallet_reads
        WHERE admin_user_id = $1 AND occurred_at > now() - interval '1 hour'`,
      [adminUserId],
    );
    const wallets = rows[0]?.n ?? 0;
    if (wallets < this.threshold) return;

    const details = { walletsInLastHour: wallets, threshold: this.threshold };
    const raised = await this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `admin-alert:${KIND}:${adminUserId}`,
      ]);
      const recent = await tx.query(
        `SELECT 1 FROM admin_activity_alerts
          WHERE actor_id = $1 AND kind = $2 AND occurred_at > now() - interval '1 hour'
          LIMIT 1`,
        [adminUserId, KIND],
      );
      if (recent.rows.length > 0) return false;
      await tx.query(
        `INSERT INTO admin_activity_alerts (alert_id, kind, actor_id, details)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [randomUUID(), KIND, adminUserId, JSON.stringify(details)],
      );
      return true;
    });
    if (raised) {
      this.logger.warn({
        alert: KIND,
        actorId: adminUserId,
        ...details,
        msg: 'admin activity alert',
      });
    }
  }

  /** Alerts about admins in this service, newest first, at most 100. */
  async alerts(limit = 100) {
    const { rows } = await this.db.query<
      {
        alert_id: string;
        kind: string;
        actor_id: string;
        details: unknown;
        occurred_at: Date | string;
      } & Row
    >(
      `SELECT alert_id, kind, actor_id, details, occurred_at FROM admin_activity_alerts
        ORDER BY occurred_at DESC, alert_id LIMIT $1`,
      [limit],
    );
    return {
      items: rows.map((a) => ({
        alertId: a.alert_id,
        kind: a.kind,
        actorId: a.actor_id,
        details: a.details,
        occurredAt: new Date(a.occurred_at).toISOString(),
      })),
    };
  }
}
