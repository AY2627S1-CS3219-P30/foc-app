import { Module } from '@nestjs/common';
import { EventsModule, PlatformModule, provideOutboxRelay } from '@foc/platform';
import { env, SERVICE_NAME, SERVICE_VERSION } from './config.js';
import { DB } from './db/db.js';
import { UsersModule } from './users/users.module.js';

/**
 * EventsModule is imported only when a broker URL is configured. A developer
 * running `npm run dev:user` without the stack up still gets a working service
 * — they just cannot publish. Compose always supplies the URL.
 *
 * Every event is written to `outbox_events` in the transaction that caused it;
 * the relay publishes committed rows (EVT-02). Without a broker the rows wait,
 * and go out once the service runs with one.
 */
const eventModules = env.RABBITMQ_URL
  ? [EventsModule.forRoot({ url: env.RABBITMQ_URL, producer: SERVICE_NAME })]
  : [];
const eventProviders = env.RABBITMQ_URL ? [provideOutboxRelay({ db: DB })] : [];

@Module({
  imports: [
    PlatformModule.forRoot({
      serviceName: SERVICE_NAME,
      version: SERVICE_VERSION,
      logLevel: env.LOG_LEVEL,
    }),
    UsersModule.forRoot(),
    ...eventModules,
  ],
  providers: eventProviders,
})
export class AppModule {}
