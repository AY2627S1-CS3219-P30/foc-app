import { Module } from '@nestjs/common';
import { PlatformModule } from '@foc/platform';
import { env, SERVICE_NAME, SERVICE_VERSION } from './config.js';

@Module({
  imports: [
    PlatformModule.forRoot({
      serviceName: SERVICE_NAME,
      version: SERVICE_VERSION,
      logLevel: env.LOG_LEVEL,
    }),
  ],
})
export class AppModule {}
