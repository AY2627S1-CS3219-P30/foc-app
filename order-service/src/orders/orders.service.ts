import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '@foc/auth-client';
import { ApiException } from '@foc/platform';
import { IdempotencyKeyReusedError, OrdersRepository } from './orders.repository.js';
import { SupplierClient } from './supplier.client.js';
import type { OrderRow, OrderView } from './types.js';
import type { CreateOrderInput } from './validation.js';

const notFound = () => new ApiException(404, 'NOT_FOUND', 'Order not found.');

export function projectOrder(
  order: OrderRow,
  caller: Pick<AuthContext, 'userId' | 'isAdmin'>,
): OrderView | null {
  const isRequester = caller.userId === order.requesterId;
  const isCourier = caller.userId === order.courierId;
  const isParticipant = isRequester || isCourier || caller.isAdmin;

  // Pending and rejected requests are private to their requester (and admins).
  if (
    (order.status === 'PENDING_CREDIT' || order.status === 'REJECTED') &&
    !isRequester &&
    !caller.isAdmin
  ) {
    return null;
  }

  return {
    orderId: order.orderId,
    supplier: order.supplierSnapshot,
    items: order.items,
    deliveryZone: order.deliveryZone,
    reward: order.reward,
    status: order.status,
    version: order.version,
    acceptanceDeadlineAt: order.acceptanceDeadlineAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    ...(isParticipant
      ? {
          requesterId: order.requesterId,
          ...(order.courierId ? { courierId: order.courierId } : {}),
          deliveryInstructions: order.deliveryInstructions,
        }
      : {}),
    ...(order.status === 'REJECTED' && isParticipant && order.rejectionReason
      ? {
          rejection: {
            reason: order.rejectionReason,
            ...(order.availableAtRejection === null
              ? {}
              : { available: order.availableAtRejection }),
          },
        }
      : {}),
  };
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(OrdersRepository) private readonly orders: OrdersRepository,
    @Inject(SupplierClient) private readonly suppliers: SupplierClient,
  ) {}

  async getById(orderId: string, caller: AuthContext): Promise<OrderView> {
    const order = await this.orders.findById(orderId);
    if (!order) throw notFound();
    const projected = projectOrder(order, caller);
    if (!projected) throw notFound();
    return projected;
  }

  async create(
    input: CreateOrderInput,
    idempotencyKey: string,
    caller: AuthContext,
    authorization: string,
    correlationId: string,
  ): Promise<{ order: OrderView; replayed: boolean }> {
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify(input, (_key, value) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
        ),
      )
      .digest('hex');

    // A replay does not re-contact Supplier: it returns the exact recorded
    // order even if the dependency is down or the supplier changed meanwhile.
    const existing = await this.orders.findIdempotent(caller.userId, idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) throw this.idempotencyReused();
      const projected = projectOrder(existing.order, caller);
      if (!projected) throw notFound();
      return { order: projected, replayed: true };
    }

    const supplierSnapshot = await this.suppliers.getActive(input.supplierId, authorization);
    try {
      const created = await this.orders.createPending({
        ...input,
        requesterId: caller.userId,
        supplierSnapshot,
        idempotencyKey,
        requestHash,
        correlationId,
      });
      const projected = projectOrder(created.order, caller);
      if (!projected) throw notFound();
      return { order: projected, replayed: created.replayed };
    } catch (error) {
      if (error instanceof IdempotencyKeyReusedError) throw this.idempotencyReused();
      throw error;
    }
  }

  private idempotencyReused(): ApiException {
    return new ApiException(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different order request.',
    );
  }
}
