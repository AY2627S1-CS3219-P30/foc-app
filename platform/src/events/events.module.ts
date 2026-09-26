import {
  DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { BrokerConnection } from './connection.js';
import { EventConsumer } from './consumer.js';
import { EventPublisher } from './publisher.js';
import type { SubscriptionSpec } from './topology.js';

export const BROKER = Symbol('BROKER');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
export const EVENT_CONSUMER = Symbol('EVENT_CONSUMER');

export interface EventsModuleOptions {
  url: string;
  producer: string;
  /** Queues this service consumes, declared up front so topology is reproducible. */
  subscriptions?: SubscriptionSpec[];
  /** Override the retry backoff. Defaults to 1s, 5s, 15s, 60s. */
  retryDelaysMs?: readonly number[];
}

/**
 * Wires a service to the broker. Import once, then inject EVENT_PUBLISHER to
 * send and EVENT_CONSUMER to subscribe.
 *
 * Connects during module init and closes on shutdown, so `docker compose down`
 * leaves no half-open channels behind.
 */
@Global()
@Module({})
export class EventsModule implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(BROKER) private readonly broker: BrokerConnection) {}

  static forRoot(options: EventsModuleOptions): DynamicModule {
    const broker = new BrokerConnection(
      options.url,
      options.producer,
      options.subscriptions ?? [],
      options.retryDelaysMs,
    );
    return {
      module: EventsModule,
      providers: [
        { provide: BROKER, useValue: broker },
        { provide: EVENT_PUBLISHER, useValue: new EventPublisher(broker, options.producer) },
        { provide: EVENT_CONSUMER, useValue: new EventConsumer(broker) },
      ],
      exports: [BROKER, EVENT_PUBLISHER, EVENT_CONSUMER],
    };
  }

  async onModuleInit(): Promise<void> {
    await this.broker.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.broker.close();
  }
}
