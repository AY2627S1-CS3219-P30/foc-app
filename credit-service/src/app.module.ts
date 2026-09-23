import { Module } from '@nestjs/common';
import { EventsModule, EVENTS, PlatformModule } from '@foc/platform';
import { env, SERVICE_NAME, SERVICE_VERSION } from './config.js';
import { WalletProvisioning } from './wallet-provisioning.js';

const WALLET_QUEUE = 'foc.credit.wallet-provisioning';

/**
 * EventsModule is imported only when a broker URL is configured, so the
 * service still runs locally without the stack up.
 */
const eventModules = env.RABBITMQ_URL
  ? [
      EventsModule.forRoot({
        url: env.RABBITMQ_URL,
        producer: SERVICE_NAME,
        subscriptions: [{ queue: WALLET_QUEUE, routingKeys: [EVENTS.USER_ACTIVATED] }],
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
    ...eventModules,
  ],
  providers: env.RABBITMQ_URL ? [WalletProvisioning] : [],
})
export class AppModule {}

export { WALLET_QUEUE };
