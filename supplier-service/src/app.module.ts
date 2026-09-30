import { Module } from '@nestjs/common';
import { authStatusEvents, AuthModule } from '@foc/auth-client';
import { EventsModule, PlatformModule } from '@foc/platform';
import { authConfig, env, SERVICE_NAME, SERVICE_VERSION } from './config.js';
import { SuppliersModule } from './suppliers/suppliers.module.js';

/**
 * The admin endpoints (`@AdminOnly()`) read the caller's live status and roles from the User
 * Service (USR-07). A cached answer is at most 5 s old, and a `user.suspended` /
 * `user.reactivated` / `user.role-changed` event drops it at once — so a demoted or suspended
 * administrator loses access here on their next request.
 */
const status = authStatusEvents('supplier', authConfig);

/**
 * EventsModule is imported only when a broker URL is configured, matching the
 * other services: a developer running `npm run dev:supplier` without the stack
 * up still gets a working service, relying on the cache window alone. Compose
 * always supplies the URL.
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
    // Verifies callers and resolves their live identity via the User Service.
    AuthModule.forRoot(authConfig),
    SuppliersModule.forRoot(),
    ...eventModules,
  ],
  providers: env.RABBITMQ_URL ? status.providers : [],
})
export class AppModule {}
