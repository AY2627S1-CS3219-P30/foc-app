import { Module } from '@nestjs/common';
import { authStatusEvents, AuthModule } from '@foc/auth-client';
import { EventsModule, PlatformModule, provideOutboxRelay } from '@foc/platform';
import { authConfig, env, SERVICE_NAME, SERVICE_VERSION } from './config.js';
import { CREDIT_ECONOMIC_SUBSCRIPTIONS } from './closed-economy.js';
import { CreditModule } from './credit.module.js';
import { RAW_DB } from './db/db.js';
import { ReservationConsumer } from './reservation-consumer.js';
import { CompletionConsumer, ReleaseConsumer } from './terminal-consumers.js';
import { WALLET_QUEUE, WalletProvisioning } from './wallet-provisioning.js';

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
          ...CREDIT_ECONOMIC_SUBSCRIPTIONS.map(({ queue, routingKeys }) => ({
            queue,
            routingKeys: [...routingKeys],
          })),
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
        CompletionConsumer,
        ReleaseConsumer,
        provideOutboxRelay({ db: RAW_DB }),
        ...status.providers,
      ]
    : [],
})
export class AppModule {}

export { WALLET_QUEUE };
