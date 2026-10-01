import { Module } from '@nestjs/common';
import { authStatusEvents, AuthModule } from '@foc/auth-client';
import { EventsModule, EVENTS, PlatformModule, provideOutboxRelay } from '@foc/platform';
import { authConfig, env, SERVICE_NAME, SERVICE_VERSION } from './config.js';
import { CreditModule } from './credit.module.js';
import { RAW_DB } from './db/db.js';
import { RESERVATION_QUEUE, ReservationConsumer } from './reservation-consumer.js';
import { WalletProvisioning } from './wallet-provisioning.js';

const WALLET_QUEUE = 'foc.credit.wallet-provisioning';

/**
 * Every wallet endpoint must use `@Authenticated()` from `@foc/auth-client`, which reads the caller's
 * live status from the User Service (USR-07). A cached answer is at most 5 s old, and a
 * `user.suspended` / `user.reactivated` / `user.role-changed` event drops it at once.
 */
const status = authStatusEvents('credit', authConfig);

/**
 * EventsModule is imported only when a broker URL is configured, so the
 * service still runs locally without the stack up.
 */
const eventModules = env.RABBITMQ_URL
  ? [
      EventsModule.forRoot({
        url: env.RABBITMQ_URL,
        producer: SERVICE_NAME,
        subscriptions: [
          { queue: WALLET_QUEUE, routingKeys: [EVENTS.USER_ACTIVATED] },
          { queue: RESERVATION_QUEUE, routingKeys: [EVENTS.CREDIT_RESERVATION_REQUESTED] },
          status.subscription,
        ],
      }),
    ]
  : [];

@Module({
  imports: [
    PlatformModule.forRoot({
      serviceName: SERVICE_NAME,
      version: SERVICE_VERSION,
      logLevel: env.LOG_LEVEL,
    }),
    AuthModule.forRoot(authConfig),
    CreditModule.forRoot(),
    ...eventModules,
  ],
  providers: env.RABBITMQ_URL
    ? [
        WalletProvisioning,
        ReservationConsumer,
        provideOutboxRelay({ db: RAW_DB }),
        ...status.providers,
      ]
    : [],
})
export class AppModule {}

export { WALLET_QUEUE };
