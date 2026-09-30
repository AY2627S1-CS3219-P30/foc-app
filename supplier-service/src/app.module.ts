import { Module } from '@nestjs/common';
import { AuthModule } from '@foc/auth-client';
import { EventsModule, PlatformModule } from '@foc/platform';
import { authConfig, env, SERVICE_NAME, SERVICE_VERSION } from './config.js';
import { SuppliersModule } from './suppliers/suppliers.module.js';

/**
 * EventsModule is imported only when a broker URL is configured, matching the
 * other services: a developer running `npm run dev:supplier` without the stack
 * up still gets a working service. Compose always supplies the URL.
 */
const eventModules = env.RABBITMQ_URL
  ? [EventsModule.forRoot({ url: env.RABBITMQ_URL, producer: SERVICE_NAME })]
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
})
export class AppModule {}
