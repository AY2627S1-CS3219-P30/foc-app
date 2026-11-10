// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5, Claude Opus 5, Claude Sonnet 5, Claude Opus 4.8), dates:
//   2026-09-20 to 2026-09-30
// Scope: Generated the initial implementation for "scaffold the four services on a shared runtime"
//   (USR-01, EVT-02); later new features.
// Author review: Jonus Ho, Anselm Long and Patrick Thomas validated the behaviour and the
//   implementation, checked for fatal errors, and confirmed it does not conflict with the
//   architecture before committing.

import { Module } from '@nestjs/common';
import {
  EventsModule,
  PlatformModule,
  provideEventTablePruner,
  provideOutboxRelay,
} from '@foc/platform';
import { env, SERVICE_NAME, SERVICE_VERSION } from './config.js';
import { RAW_DB } from './db/db.js';
import { UsersModule } from './users/users.module.js';

/**
 * EventsModule is imported only when a broker URL is configured. A developer
 * running `npm run dev:user` without the stack up still gets a working service
 * — they just cannot publish. Compose always supplies the URL.
 *
 * Every event is written to `outbox_events` in the transaction that caused it;
 * the relay publishes committed rows (EVT-02). Without a broker the rows wait,
 * and go out once the service runs with one. The pruner runs either way (PLT-12).
 */
const eventModules = env.RABBITMQ_URL
  ? [EventsModule.forRoot({ url: env.RABBITMQ_URL, producer: SERVICE_NAME })]
  : [];
const eventProviders = env.RABBITMQ_URL ? [provideOutboxRelay({ db: RAW_DB })] : [];

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
  providers: [provideEventTablePruner({ db: RAW_DB }), ...eventProviders],
})
export class AppModule {}
