import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '@foc/auth-client';
import { ApiException } from '@foc/platform';
import { OrdersRepository } from './orders.repository.js';
import type { OrderRow, OrderView } from './types.js';

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
  constructor(@Inject(OrdersRepository) private readonly orders: OrdersRepository) {}

  async getById(orderId: string, caller: AuthContext): Promise<OrderView> {
    const order = await this.orders.findById(orderId);
    if (!order) throw notFound();
    const projected = projectOrder(order, caller);
    if (!projected) throw notFound();
    return projected;
  }
}
