import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '@foc/auth-client';
import { ApiException } from '@foc/platform';
import { IdempotencyKeyReusedError, OrdersRepository } from './orders.repository.js';
import { SupplierClient } from './supplier.client.js';
import type { OpenOrderSummary, OrderRow, OrderView } from './types.js';
import type { CreateOrderInput } from './validation.js';

const notFound = () => new ApiException(404, 'NOT_FOUND', 'Order not found.');

export function projectOrder(
  order: OrderRow,
  caller: Pick<AuthContext, 'userId' | 'isAdmin'>,
): OrderView | null {
  const isRequester = caller.userId === order.requesterId;
  const isCourier = caller.userId === order.courierId;
  const isReferredAdmin = caller.isAdmin && caller.userId === order.referredAdminId;
  const canReadPrivate = isRequester || isCourier || isReferredAdmin;

  // Pending and rejected requests are private to their requester (and admins).
  if (
    (order.status === 'PENDING_CREDIT' || order.status === 'REJECTED') &&
    !isRequester &&
    !isReferredAdmin
  ) {
    return null;
  }

  return {
    orderId: order.orderId,
    supplier: order.supplierSnapshot,
    items: canReadPrivate
      ? order.items
      : order.items.map(({ name, quantity }) => ({ name, quantity })),
    deliveryZone: order.deliveryZone,
    reward: order.reward,
    status: order.status,
    version: order.version,
    acceptanceDeadlineAt: order.acceptanceDeadlineAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    ...(canReadPrivate
      ? {
          requesterId: order.requesterId,
          ...(order.courierId ? { courierId: order.courierId } : {}),
          deliveryInstructions: order.deliveryInstructions,
        }
      : {}),
    ...(order.status === 'REJECTED' && canReadPrivate && order.rejectionReason
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

  async listOpen(): Promise<OpenOrderSummary[]> {
    return this.orders.listOpen();
  }

  async getById(orderId: string, caller: AuthContext, privateView = false): Promise<OrderView> {
    const order = await this.orders.findById(orderId);
    if (!order) throw notFound();
    const projected = projectOrder(order, caller);
    if (!projected) throw notFound();
    if (privateView && !projected.deliveryInstructions) {
      throw new ApiException(
        403,
        'PRIVATE_ORDER_FORBIDDEN',
        'Only an order participant or its referred administrator may read private details.',
      );
    }
    return projected;
  }

  async accept(
    orderId: string,
    expectedVersion: number,
    caller: AuthContext,
    correlationId: string,
  ): Promise<OrderView> {
    const attempt = await this.orders.accept(
      orderId,
      caller.userId,
      expectedVersion,
      correlationId,
    );
    if (attempt.accepted) {
      const projected = projectOrder(attempt.order, caller);
      if (!projected) throw notFound();
      return projected;
    }

    const current = attempt.order;
    if (!current) throw notFound();
    if (current.requesterId === caller.userId) {
      throw new ApiException(
        403,
        'SELF_ACCEPTANCE_FORBIDDEN',
        'A requester cannot accept their own order.',
      );
    }
    const details = { status: current.status, version: current.version };
    if (current.status !== 'OPEN') {
      throw new ApiException(409, 'ORDER_NOT_OPEN', 'The order is no longer open.', details);
    }
    if (
      !current.acceptanceDeadlineAt ||
      new Date(current.acceptanceDeadlineAt).getTime() <= Date.now()
    ) {
      throw new ApiException(
        409,
        'ACCEPTANCE_DEADLINE_PASSED',
        'The acceptance deadline has passed.',
        details,
      );
    }
    throw new ApiException(
      409,
      'ORDER_CHANGED',
      'The order changed before it could be accepted.',
      details,
    );
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
