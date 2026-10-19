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
import { SUSPENSION_EFFECTS } from './orders/order-state-machine.js';
import { LOCK_THEN_ASK_PREFETCH, UserDirectoryClient } from './orders/user-directory.client.js';

export const USER_SUSPENSIONS_QUEUE = 'foc.order.user-suspensions';

/**
 * ORD-06 — what a suspension does to the user's errands (OS-FR8). The other participant is not
 * punished for it, so nothing freezes:
 *
 * - as requester, an errand not yet picked up is cancelled and its credits returned; a picked-up
 *   one is referred to an administrator once its delivery period has passed (until then it
 *   continues, marked, and the lifecycle scheduler refers it when the period ends if the requester
 *   is still suspended);
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
      prefetch: LOCK_THEN_ASK_PREFETCH,
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
        const effect = SUSPENSION_EFFECTS[asRequester ? 'REQUESTER' : 'COURIER'];
        const action = effect.actions[order.status];
        // An errand waiting for its reservation is locked only; the reply decides it.
        if (!action) continue;
        const result = await this.orders.transition(
          {
            orderId: order.orderId,
            action,
            actor: { kind: 'SYSTEM', id: 'user-suspensions' },
            correlationId: envelope.correlationId,
            causationId: envelope.eventId,
            requesterSuspended: asRequester,
            reason: effect.reason,
          },
          tx,
        );
        if (result.kind === 'applied') changed += 1;
        // Still within its delivery period: the scheduler asks again once the period ends.
        else if (asRequester && order.status === 'PICKED_UP') {
          await this.orders.noteRequesterSuspended(tx, order.orderId);
        }
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
