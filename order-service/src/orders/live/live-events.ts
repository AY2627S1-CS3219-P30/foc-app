import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnApplicationBootstrap, type Provider } from '@nestjs/common';
import {
  EVENT_CONSUMER,
  EVENTS,
  orderStatusChangedPayload,
  type Envelope,
  type EventConsumer,
  type OrderStatusChangedPayload,
  type SubscriptionSpec,
} from '@foc/platform';
import { OrdersRepository } from '../orders.repository.js';
import { LiveHub } from './live-hub.js';

const LIVE_QUEUE = Symbol('FOC_LIVE_QUEUE');

/**
 * Hands each status change to the hub, with how to read the errand's participants: its row, by
 * primary key, read only when a stream is open.
 */
export function liveStatusHandler(
  hub: LiveHub,
  orders: Pick<OrdersRepository, 'findById'>,
): (envelope: Envelope<OrderStatusChangedPayload>) => Promise<void> {
  return (envelope) =>
    hub.changed(envelope.payload, async (orderId) => {
      const order = await orders.findById(orderId);
      return order && { requesterId: order.requesterId, courierId: order.courierId };
    });
}

@Injectable()
export class LiveStatusChanges implements OnApplicationBootstrap {
  constructor(
    @Inject(EVENT_CONSUMER) private readonly consumer: EventConsumer,
    @Inject(LiveHub) private readonly hub: LiveHub,
    @Inject(OrdersRepository) private readonly orders: OrdersRepository,
    @Inject(LIVE_QUEUE) private readonly queue: string,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe({
      queue: this.queue,
      eventType: EVENTS.ORDER_STATUS_CHANGED,
      expectedProducer: 'order-service',
      payloadSchema: orderStatusChangedPayload,
      handler: liveStatusHandler(this.hub, this.orders),
    });
  }
}

/**
 * N1.4 (#329) — what live updates need from the broker, as `authStatusEvents` is for identity
 * changes. Every **instance** gets its own queue (`foc.order.live.<random>`), because each holds
 * its own streams: a queue shared by replicas would hand each change to one of them. It is
 * exclusive and auto-deleted, so it holds nothing durable: `order.status-changed` still has no
 * durable consumer and its delivery is unchanged (`REQUIRES_CONSUMER`). A nudge older than 30 s is
 * worthless, and a page polls anyway, so the queue keeps no more than that, and at most 1,000.
 */
export function liveEvents(): { subscription: SubscriptionSpec; providers: Provider[] } {
  const queue = `foc.order.live.${randomUUID()}`;
  return {
    subscription: {
      queue,
      metricsLabel: 'foc.order.live',
      routingKeys: [EVENTS.ORDER_STATUS_CHANGED],
      exclusive: true,
      autoDelete: true,
      messageTtlMs: 30_000,
      maxLength: 1_000,
    },
    providers: [{ provide: LIVE_QUEUE, useValue: queue }, LiveStatusChanges],
  };
}
