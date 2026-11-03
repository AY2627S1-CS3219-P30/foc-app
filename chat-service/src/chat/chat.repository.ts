import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Queryable, Row } from '@foc/platform';
import { CHAT_DB, type ChatDatabase } from '../db/db.js';
import { MAX_SEQ, type Page } from './validation.js';

/** ADR 0012 §5: new messages per sender, across all channels, in a rolling window. */
export const SEND_LIMIT = { messages: 20, windowSeconds: 60 } as const;

/** The advisory-lock namespace that serializes one sender's sends, for the rate limit. */
const SENDER_LOCK = 0x63686174; // 'chat'

export type SendResult =
  | { message: Message; created: boolean }
  /** Over the limit: whole seconds until the oldest message in the window leaves it. */
  | { retryAfter: number };

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
   * The channel's row lock orders sends on it, so a retry racing its original finds it here. A new
   * message then takes the sender's advisory lock, always second, so one sender's sends on
   * different channels count and insert one at a time and a burst cannot pass the limit.
   */
  async send(
    orderId: string,
    senderId: string,
    clientId: string,
    body: string,
  ): Promise<SendResult> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ latest_seq: number } & Row>(
        'SELECT latest_seq FROM channels WHERE order_id = $1 FOR UPDATE',
        [orderId],
      );
      const stored = await this.findSent(orderId, senderId, clientId, tx);
      if (stored) return { message: stored, created: false };
      await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [SENDER_LOCK, senderId]);
      const retryAfter = await this.retryAfter(tx, senderId);
      if (retryAfter !== undefined) return { retryAfter };
      const seq = Number(rows[0]!.latest_seq) + 1;
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
    });
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

  async recordAdminRead(
    adminUserId: string,
    orderId: string,
    resource: 'CHANNEL' | 'MESSAGES',
    correlationId: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO admin_channel_reads (id, admin_user_id, order_id, resource, correlation_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), adminUserId, orderId, resource, correlationId],
    );
  }

  /**
   * Channels opened before `cutoff`. A channel opens only before its errand ends, so one opened
   * since cannot be past retention, and the cleanup need not ask about it.
   */
  async channelsOpenedBefore(cutoff: Date): Promise<string[]> {
    const { rows } = await this.db.query<{ order_id: string } & Row>(
      'SELECT order_id FROM channels WHERE created_at < $1 ORDER BY created_at',
      [cutoff.toISOString()],
    );
    return rows.map((row) => row.order_id);
  }

  /** Deletes the channel with its messages and read positions; admin read records stay. */
  async deleteChannel(orderId: string): Promise<void> {
    await this.db.query('DELETE FROM channels WHERE order_id = $1', [orderId]);
  }
}
