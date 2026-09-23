import { Module } from '@nestjs/common';
import { EventsModule, PlatformModule } from '@foc/platform';
import { env, SERVICE_NAME, SERVICE_VERSION } from './config.js';

/**
 * EventsModule is imported only when a broker URL is configured. A developer
 * running `npm run dev:user` without the stack up still gets a working service
 * — they just cannot publish. Compose always supplies the URL.
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
    ...eventModules,
  ],
})
export class AppModule {}
