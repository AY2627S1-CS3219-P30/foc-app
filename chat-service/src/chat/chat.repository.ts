// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-30 to 2026-11-05
// Scope: Generated the initial implementation for "channels and messages for an errand" (NTH-02,
//   #162, NTH-03); later bug fixes and new features.
// Author review: Anselm Long, Jonus Ho and Zhang Yuan checked the code for correctness against the
//   ticket, confirmed the tests pass, and made sure it caused no fatal errors or architectural
//   conflicts before committing.

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Queryable, Row } from '@foc/platform';
import { CHAT_DB, type ChatDatabase } from '../db/db.js';
import { MAX_SEQ, type Page } from './validation.js';

/** ADR 0012 §5: new messages per sender, across all channels, in a rolling window. */
export const SEND_LIMIT = { messages: 20, windowSeconds: 60 } as const;

/** The advisory-lock namespace that serializes one sender's sends, for the rate limit. */
const SENDER_LOCK = 0x63686174; // 'chat'

/**
 * How long a send waits for either of its locks, in milliseconds. Well under the pool's 5 s
 * connection timeout, so sends queued behind a stuck one give their connections back before anyone
 * else's request gives up waiting for one.
 */
const LOCK_WAIT_MS = 2_000;

/** What PostgreSQL raises when `lock_timeout` runs out. */
const LOCK_NOT_AVAILABLE = '55P03';

/** Waits for `senderId`'s lock, until the transaction ends, so their sends go one at a time. */
export const lockSender = (tx: Queryable, senderId: string) =>
  tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [SENDER_LOCK, senderId]);

export type SendResult =
  | { message: Message; created: boolean }
  /** Over the limit: whole seconds until the oldest message in the window leaves it. */
  | { retryAfter: number };

export type SendAttempt =
  | SendResult
  /** The channel was deleted while the send waited for its locks. */
  | { closed: true }
  /** A lock took longer than `LOCK_WAIT_MS`. Nothing was stored, so the send can be retried. */
  | { busy: true };

export interface Message {
  seq: number;
  clientId: string;
  senderId: string;
  body: string;
  sentAt: string;
}

type StoredMessage = Row & {
  seq: number;
  client_id: string;
  sender_id: string;
  body: string;
  sent_at: Date | string;
};

const MESSAGE_COLUMNS = 'seq, client_id, sender_id, body, sent_at';

const toMessage = (row: StoredMessage): Message => ({
  seq: Number(row.seq),
  clientId: row.client_id,
  senderId: row.sender_id,
  body: row.body,
  sentAt: new Date(row.sent_at).toISOString(),
});

@Injectable()
export class ChatRepository {
  constructor(@Inject(CHAT_DB) private readonly db: ChatDatabase) {}

  /** The channel's newest `seq`, 0 before any message; undefined when it has no channel. */
  async latestSeq(orderId: string): Promise<number | undefined> {
    const { rows } = await this.db.query<{ latest_seq: number } & Row>(
      'SELECT latest_seq FROM channels WHERE order_id = $1',
      [orderId],
    );
    return rows[0] ? Number(rows[0].latest_seq) : undefined;
  }

  /** Opens the errand's channel, or finds the one a concurrent request just opened. */
  async open(orderId: string): Promise<number> {
    await this.db.query('INSERT INTO channels (order_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      orderId,
    ]);
    return (await this.latestSeq(orderId))!;
  }

  async lastRead(orderId: string, userId: string): Promise<number> {
    const { rows } = await this.db.query<{ last_read_seq: number } & Row>(
      'SELECT last_read_seq FROM read_positions WHERE order_id = $1 AND user_id = $2',
      [orderId, userId],
    );
    return rows[0] ? Number(rows[0].last_read_seq) : 0;
  }

  /**
   * At most `limit` messages in ascending `seq`: the first above `after`, the last below `before`,
   * or the latest. `hasMore`: more lie in the direction read, newer for `after`, older otherwise.
   */
  async page(orderId: string, { after, before, limit }: Page) {
    const newer = after !== undefined;
    const { rows } = await this.db.query<StoredMessage>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
        WHERE order_id = $1 AND seq > $2 AND seq < $3
        ORDER BY seq ${newer ? 'ASC' : 'DESC'}
        LIMIT $4`,
      [orderId, after ?? 0, before ?? MAX_SEQ, limit + 1],
    );
    const items = rows.slice(0, limit).map(toMessage);
    return { items: newer ? items : items.reverse(), hasMore: rows.length > limit };
  }

  async findSent(
    orderId: string,
    senderId: string,
    clientId: string,
    db: Queryable = this.db,
  ): Promise<Message | undefined> {
    const { rows } = await db.query<StoredMessage>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
        WHERE order_id = $1 AND sender_id = $2 AND client_id = $3`,
      [orderId, senderId, clientId],
    );
    return rows[0] ? toMessage(rows[0]) : undefined;
  }

  /**
   * Stores a message as the channel's next `seq`, or finds the one this `clientId` already stored.
   * The sender's advisory lock comes first, so one sender's sends on different channels count and
   * insert one at a time and a burst cannot pass the limit. The channel's row lock comes second and
   * orders sends on it. Always in that order: a sender waiting for their own lock then holds no
   * channel, and a transaction holding a channel waits for nothing more. Each wait is capped, because
   * a waiting send still holds a pool connection.
   */
  async send(
    orderId: string,
    senderId: string,
    clientId: string,
    body: string,
  ): Promise<SendAttempt> {
    return this.db
      .transaction<SendAttempt>((tx) => this.sendUnderLocks(tx, orderId, senderId, clientId, body))
      .catch((err: unknown) => {
        if ((err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) return { busy: true };
        throw err;
      });
  }

  private async sendUnderLocks(
    tx: Queryable,
    orderId: string,
    senderId: string,
    clientId: string,
    body: string,
  ): Promise<SendAttempt> {
    await tx.query(`SET LOCAL lock_timeout = ${LOCK_WAIT_MS}`);
    await lockSender(tx, senderId);
    const { rows } = await tx.query<{ latest_seq: number } & Row>(
      'SELECT latest_seq FROM channels WHERE order_id = $1 FOR UPDATE',
      [orderId],
    );
    if (!rows[0]) return { closed: true };
    const stored = await this.findSent(orderId, senderId, clientId, tx);
    if (stored) return { message: stored, created: false };
    const retryAfter = await this.retryAfter(tx, senderId);
    if (retryAfter !== undefined) return { retryAfter };
    const seq = Number(rows[0].latest_seq) + 1;
    const inserted = await tx.query<StoredMessage>(
      // Stamped when written, not when the transaction began: a send that waited for the locks
      // would otherwise leave the rate window early.
      `INSERT INTO messages (order_id, seq, sender_id, client_id, body, sent_at)
       VALUES ($1, $2, $3, $4, $5, statement_timestamp())
       RETURNING ${MESSAGE_COLUMNS}`,
      [orderId, seq, senderId, clientId, body],
    );
    await tx.query('UPDATE channels SET latest_seq = $2 WHERE order_id = $1', [orderId, seq]);
    return { message: toMessage(inserted.rows[0]!), created: true };
  }

  /**
   * Undefined while the sender is under the limit. Counted on the database clock that stamps
   * `sent_at`, so the app's clock cannot skew it. `statement_timestamp()`, not `now()`: `now()` is
   * when this transaction began, before it waited for the lock, and could put the oldest message
   * more than 60 seconds away. Under the sender's lock the window never holds more than the limit,
   * so its oldest message is the one to wait for.
   */
  private async retryAfter(tx: Queryable, senderId: string): Promise<number | undefined> {
    const { rows } = await tx.query<{ n: number; retry_after: number | null } & Row>(
      `SELECT count(*)::int AS n,
              GREATEST(1, CEIL(EXTRACT(EPOCH FROM
                min(sent_at) + make_interval(secs => $2) - statement_timestamp())))::int AS retry_after
         FROM messages
        WHERE sender_id = $1 AND sent_at > statement_timestamp() - make_interval(secs => $2)`,
      [senderId, SEND_LIMIT.windowSeconds],
    );
    return Number(rows[0]!.n) >= SEND_LIMIT.messages ? Number(rows[0]!.retry_after) : undefined;
  }

  /** Moves the caller's read position forward to `seq`; never back. */
  async markRead(orderId: string, userId: string, seq: number): Promise<number> {
    const { rows } = await this.db.query<{ last_read_seq: number } & Row>(
      `INSERT INTO read_positions (order_id, user_id, last_read_seq) VALUES ($1, $2, $3)
       ON CONFLICT (order_id, user_id)
       DO UPDATE SET last_read_seq = GREATEST(read_positions.last_read_seq, EXCLUDED.last_read_seq)
       RETURNING last_read_seq`,
      [orderId, userId, seq],
    );
    return Number(rows[0]!.last_read_seq);
  }

  /**
   * Counts the read in this admin's row for the errand, resource and UTC hour, on the database
   * clock. The hour's first read keeps its correlation ID and `read_at`.
   */
  async recordAdminRead(
    adminUserId: string,
    orderId: string,
    resource: 'CHANNEL' | 'MESSAGES',
    correlationId: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO admin_channel_reads
         (id, admin_user_id, order_id, resource, correlation_id, read_hour)
       VALUES ($1, $2, $3, $4, $5, date_trunc('hour', statement_timestamp(), 'UTC'))
       ON CONFLICT (admin_user_id, order_id, resource, read_hour) DO UPDATE
         SET read_count = admin_channel_reads.read_count + 1, last_read_at = statement_timestamp()`,
      [randomUUID(), adminUserId, orderId, resource, correlationId],
    );
  }

  /**
   * A page of the channels opened before `cutoff`, after the errand ID `after`. A channel opens
   * only before its errand ends, so one opened since cannot be past retention, and the cleanup need
   * not ask about it. Paged by ID, not by offset, so a channel deleted between pages moves nothing.
   */
  async channelsOpenedBefore(cutoff: Date, limit: number, after?: string): Promise<string[]> {
    const { rows } = await this.db.query<{ order_id: string } & Row>(
      `SELECT order_id FROM channels
        WHERE created_at < $1 AND ($3::uuid IS NULL OR order_id > $3::uuid)
        ORDER BY order_id
        LIMIT $2`,
      [cutoff.toISOString(), limit, after ?? null],
    );
    return rows.map((row) => row.order_id);
  }

  /** Deletes the channel with its messages and read positions; admin read records stay. */
  async deleteChannel(orderId: string): Promise<void> {
    await this.db.query('DELETE FROM channels WHERE order_id = $1', [orderId]);
  }
}
