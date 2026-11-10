// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-30 to 2026-11-04
// Scope: Generated the initial implementation for "wire the fifth service into the stack" (NTH-11,
//   #345, NTH-02); later new features and refactoring.
// Author review: Anselm Long and Zhang Yuan validated correctness and the implementation, and
//   checked for fatal errors and architectural conflicts, before committing.

import { Module } from '@nestjs/common';
import { authStatusEvents, AuthModule } from '@foc/auth-client';
import { EventsModule, PlatformModule } from '@foc/platform';
import { ChatModule } from './chat/chat.module.js';
import { socketStatusEvents } from './chat/socket/socket-status.js';
import { authConfig, env, SERVICE_NAME, SERVICE_VERSION } from './config.js';

/**
 * Callers are verified through the User Service (ADR 0004). A cached answer is at most 5 s old,
 * and a `user.suspended` / `user.reactivated` / `user.role-changed` event drops it at once.
 */
const status = authStatusEvents('chat', authConfig);

/** And the same events close that user's chat sockets (#346), on a queue of chat's own. */
const socketStatus = socketStatusEvents(authConfig);

/**
 * EventsModule is imported only when a broker URL is configured, matching the
 * other services: `npm run dev:chat` without the stack up still boots, relying
 * on the cache window alone. Compose always supplies the URL. Chat publishes
 * nothing (ADR 0012).
 */
const eventModules = env.RABBITMQ_URL
  ? [
      EventsModule.forRoot({
        url: env.RABBITMQ_URL,
        producer: SERVICE_NAME,
        subscriptions: [status.subscription, socketStatus.subscription],
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
    ChatModule.forRoot(),
    ...eventModules,
  ],
  providers: env.RABBITMQ_URL ? [...status.providers, ...socketStatus.providers] : [],
})
export class AppModule {}
