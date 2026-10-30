import { Inject, Injectable } from '@nestjs/common';
import type { Queryable, Row } from '@foc/platform';
import { CHAT_DB, type ChatDatabase } from '../db/db.js';
import type { Page } from './validation.js';

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
      [orderId, after ?? 0, before ?? 2_147_483_647, limit + 1],
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
   * The channel's row lock orders sends on it, so a retry racing its original finds it here.
   */
  async send(
    orderId: string,
    senderId: string,
    clientId: string,
    body: string,
  ): Promise<{ message: Message; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ latest_seq: number } & Row>(
        'SELECT latest_seq FROM channels WHERE order_id = $1 FOR UPDATE',
        [orderId],
      );
      const stored = await this.findSent(orderId, senderId, clientId, tx);
      if (stored) return { message: stored, created: false };
      const seq = Number(rows[0]!.latest_seq) + 1;
      const inserted = await tx.query<StoredMessage>(
        `INSERT INTO messages (order_id, seq, sender_id, client_id, body)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${MESSAGE_COLUMNS}`,
        [orderId, seq, senderId, clientId, body],
      );
      await tx.query('UPDATE channels SET latest_seq = $2 WHERE order_id = $1', [orderId, seq]);
      return { message: toMessage(inserted.rows[0]!), created: true };
    });
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
}
