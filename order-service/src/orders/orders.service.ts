import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '@foc/auth-client';
import { ApiException } from '@foc/platform';
import { IdempotencyKeyReusedError, OrdersRepository } from './orders.repository.js';
import type { OrderAction } from './order-state-machine.js';
import { SupplierClient } from './supplier.client.js';
import type { OpenOrderSummary, OrderReceipt, OrderRow, OrderView } from './types.js';
import type { CreateOrderInput } from './validation.js';

const MY_ERRANDS_LIMIT = 100;
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

  /** The caller's own errands, each in their private projection, with `truncated` past the cap. */
  async listMine(caller: AuthContext): Promise<{
    items: Array<OrderView & { myRole: 'REQUESTER' | 'COURIER' }>;
    truncated: boolean;
  }> {
    // One extra row tells us whether the cap cut the list off.
    const orders = await this.orders.listMine(caller.userId, MY_ERRANDS_LIMIT + 1);
    return {
      items: orders.slice(0, MY_ERRANDS_LIMIT).flatMap((order) => {
        const view = projectOrder(order, caller);
        if (!view) return [];
        return [{ ...view, myRole: order.requesterId === caller.userId ? 'REQUESTER' : 'COURIER' }];
      }),
      truncated: orders.length > MY_ERRANDS_LIMIT,
    };
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
    // A pending or rejected request is private to its requester: refuse it as missing rather
    // than reveal that it exists, or its status, to anyone else.
    if (!current || !projectOrder(current, caller)) throw notFound();
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

  /**
   * Runs a participant or administrator command through the transition table. A refused command
   * changes nothing and returns 403 (this caller may never do this) or 409 (not in this state, or
   * the order changed since the caller read it), with the current status and version.
   */
  async command(
    orderId: string,
    action: OrderAction,
    expectedVersion: number,
    caller: AuthContext,
    correlationId: string,
  ): Promise<OrderView> {
    const result = await this.orders.transition({
      orderId,
      action,
      expectedVersion,
      actor: { kind: 'USER', id: caller.userId, isAdmin: caller.isAdmin },
      correlationId,
    });
    if (result.kind === 'applied') {
      const projected = projectOrder(result.order, caller);
      if (!projected) throw notFound();
      return projected;
    }
    // An order the caller may not even see stays indistinguishable from a missing one.
    if (!result.order || !projectOrder(result.order, caller)) throw notFound();
    const details = { status: result.order.status, version: result.order.version };
    if (result.reason === 'FORBIDDEN') {
      throw new ApiException(
        403,
        'ACTION_FORBIDDEN',
        'You are not allowed to perform this action on this order.',
        details,
      );
    }
    if (result.reason === 'VERSION_CONFLICT') {
      throw new ApiException(
        409,
        'ORDER_CHANGED',
        'The order changed since you last read it.',
        details,
      );
    }
    throw new ApiException(
      409,
      'INVALID_ORDER_STATE',
      'The order is not in a state that allows this action.',
      details,
    );
  }

  /** The private status history, for the order's participants and its referred administrator. */
  async history(orderId: string, caller: AuthContext) {
    const order = await this.orders.findById(orderId);
    const projected = order ? projectOrder(order, caller) : null;
    if (!order || !projected) throw notFound();
    if (!projected.deliveryInstructions) {
      throw new ApiException(
        403,
        'PRIVATE_ORDER_FORBIDDEN',
        'Only an order participant or its referred administrator may read the status history.',
      );
    }
    return { orderId, entries: await this.orders.findHistory(orderId) };
  }

  async reconciliationAttempts() {
    return { items: await this.orders.listReconciliationAttempts() };
  }

  /** Orders waiting for Credit beyond the configured period, for operators (OS-FR1.1.3). */
  async creditWaitExceeded(creditWaitTimeoutMs: number) {
    const now = await this.orders.databaseNow();
    const items = await this.orders.listCreditWaitExceeded(
      new Date(now.getTime() - creditWaitTimeoutMs),
    );
    return {
      items: items.map((item) => ({
        ...item,
        waitingMs: now.getTime() - new Date(item.createdAt).getTime(),
      })),
    };
  }

  /** The completion receipt, for the order's participants and its referred administrator. */
  async receipt(orderId: string, caller: AuthContext): Promise<OrderReceipt> {
    const order = await this.orders.findById(orderId);
    const projected = order ? projectOrder(order, caller) : null;
    if (!order || !projected) throw notFound();
    if (!projected.deliveryInstructions) {
      throw new ApiException(
        403,
        'PRIVATE_ORDER_FORBIDDEN',
        'Only an order participant or its referred administrator may read the receipt.',
      );
    }
    const receipt = await this.orders.findReceipt(orderId);
    if (!receipt) {
      throw new ApiException(404, 'RECEIPT_NOT_FOUND', 'The order has not completed yet.');
    }
    return receipt;
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

    const supplierSnapshot = await this.suppliers.getActive(
      input.supplierId,
      authorization,
      correlationId,
    );
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
