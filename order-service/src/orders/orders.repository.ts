import { Inject, Injectable } from '@nestjs/common';
import type { Row } from '@foc/platform';
import { ORDER_DB, type OrderDatabase } from '../db/db.js';
import type { OrderRow, OrderStatus, SupplierSnapshot, OrderItem } from './types.js';

type StoredOrder = Row & {
  order_id: string;
  requester_id: string;
  courier_id: string | null;
  supplier_snapshot: SupplierSnapshot;
  items: OrderItem[];
  delivery_zone: string;
  delivery_instructions: string;
  reward: number;
  status: OrderStatus;
  release_reason: 'CANCELLED' | 'EXPIRED' | null;
  rejection_reason: string | null;
  available_at_rejection: number | null;
  version: number;
  acceptance_deadline_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const nullableIso = (value: Date | string | null): string | null => (value ? iso(value) : null);

const mapOrder = (row: StoredOrder): OrderRow => ({
  orderId: row.order_id,
  requesterId: row.requester_id,
  courierId: row.courier_id,
  supplierSnapshot: row.supplier_snapshot,
  items: row.items,
  deliveryZone: row.delivery_zone,
  deliveryInstructions: row.delivery_instructions,
  reward: Number(row.reward),
  status: row.status,
  releaseReason: row.release_reason,
  rejectionReason: row.rejection_reason,
  availableAtRejection:
    row.available_at_rejection === null ? null : Number(row.available_at_rejection),
  version: Number(row.version),
  acceptanceDeadlineAt: nullableIso(row.acceptance_deadline_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

@Injectable()
export class OrdersRepository {
  constructor(@Inject(ORDER_DB) private readonly db: OrderDatabase) {}

  async findById(orderId: string): Promise<OrderRow | undefined> {
    const result = await this.db.query<StoredOrder>(
      `SELECT order_id, requester_id, courier_id, supplier_snapshot, items, delivery_zone,
              delivery_instructions, reward, status, release_reason, rejection_reason,
              available_at_rejection, version, acceptance_deadline_at, created_at, updated_at
         FROM orders
        WHERE order_id = $1`,
      [orderId],
    );
    return result.rows[0] ? mapOrder(result.rows[0]) : undefined;
  }
}
