import { Module } from '@nestjs/common';
import { authStatusEvents, AuthModule } from '@foc/auth-client';
import { EventsModule, PlatformModule } from '@foc/platform';
import { authConfig, env, SERVICE_NAME, SERVICE_VERSION } from './config.js';

/**
 * Every mutating endpoint must use `@Authenticated()` (or `@AdminOnly()`) from `@foc/auth-client`,
 * which reads the caller's live status and roles from the User Service — never from the token or a
 * header (USR-07). A cached answer is at most 5 s old, and a `user.suspended` / `user.reactivated`
 * event drops it at once.
 */
const status = authStatusEvents('order');

/**
 * EventsModule is imported only when a broker URL is configured, so the service still runs locally
 * without the stack up; it then relies on the 5 s cache window alone. Compose always supplies it.
 */
const eventModules = env.RABBITMQ_URL
  ? [
      EventsModule.forRoot({
        url: env.RABBITMQ_URL,
        producer: SERVICE_NAME,
        subscriptions: [status.subscription],
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
    ...eventModules,
  ],
  providers: env.RABBITMQ_URL ? status.providers : [],
})
export class AppModule {}
