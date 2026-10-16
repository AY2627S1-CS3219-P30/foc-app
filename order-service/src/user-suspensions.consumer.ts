import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  EVENTS,
  EVENT_CONSUMER,
  userStatusChangedPayload,
  withInbox,
  type Db,
  type Envelope,
  type EventConsumer,
  type Queryable,
  type UserStatusChangedPayload,
} from '@foc/platform';
import { ORDER_DB } from './db/db.js';
import { OrdersRepository } from './orders/orders.repository.js';
import { SUSPENSION_REASONS, type OrderAction } from './orders/order-state-machine.js';
import type { OrderStatus } from './orders/types.js';
import { UserDirectoryClient } from './orders/user-directory.client.js';

export const USER_SUSPENSIONS_QUEUE = 'foc.order.user-suspensions';

/**
 * ORD-06 — what a suspension does to the user's errands (OS-FR8). The other participant is not
 * punished for it, so nothing freezes:
 *
 * - as requester, an errand not yet picked up is cancelled and its credits returned; a picked-up
 *   one is referred to an administrator once its delivery period has passed (until then it
 *   continues, and the lifecycle scheduler refers it when the period ends);
 * - as courier, an errand not yet picked up reopens with its deadline extended by the time they
 *   held it; a picked-up one is referred to an administrator.
 *
 * A delivered errand is left to be confirmed or auto-confirmed, so credits keep moving for work
 * already done (CS-FR1.2.1). The message is only a prompt: the User Service is asked whether the
 * user is suspended now, and nothing happens if they are not, so a stale or forged message cannot
 * cancel anything. If it cannot be asked, the handler throws and the message is retried.
 */
@Injectable()
export class UserSuspensionsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(UserSuspensionsConsumer.name);

  constructor(
    @Inject(EVENT_CONSUMER) private readonly consumer: EventConsumer,
    @Inject(ORDER_DB) private readonly db: Db,
    @Inject(OrdersRepository) private readonly orders: OrdersRepository,
    @Inject(UserDirectoryClient) private readonly directory: UserDirectoryClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe({
      queue: USER_SUSPENSIONS_QUEUE,
      eventType: EVENTS.USER_SUSPENDED,
      expectedProducer: 'user-service',
      payloadSchema: userStatusChangedPayload,
      handler: withInbox(this.db, USER_SUSPENSIONS_QUEUE, (envelope, tx) =>
        this.handle(envelope, tx),
      ),
    });
  }

  private async handle(envelope: Envelope<UserStatusChangedPayload>, tx: Queryable): Promise<void> {
    const { userId } = envelope.payload;
    const suspended = await this.directory.isSuspended(userId);
    let changed = 0;
    if (suspended) {
      for (const order of await this.orders.lockActiveErrandsOf(tx, userId)) {
        const asRequester = order.requesterId === userId;
        const result = await this.orders.transition(
          {
            orderId: order.orderId,
            action: suspensionAction(order.status, asRequester),
            actor: { kind: 'SYSTEM', id: 'user-suspensions' },
            correlationId: envelope.correlationId,
            causationId: envelope.eventId,
            requesterSuspended: asRequester,
            reason: asRequester ? SUSPENSION_REASONS.REQUESTER : SUSPENSION_REASONS.COURIER,
          },
          tx,
        );
        if (result.kind === 'applied') changed += 1;
      }
    }
    this.logger.log({
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      userId,
      suspended,
      changed,
      msg: 'user suspension handled',
    });
  }
}

/**
 * A picked-up errand's requester refers it only once the delivery period passed (its guard). An
 * errand still waiting for its reservation has no rule for either action and is left to the reply.
 */
function suspensionAction(status: OrderStatus, asRequester: boolean): OrderAction {
  if (!asRequester) return 'COURIER_SUSPENDED';
  return status === 'PICKED_UP' ? 'DELIVERY_PERIOD_PASSED' : 'REQUESTER_SUSPENDED';
}
