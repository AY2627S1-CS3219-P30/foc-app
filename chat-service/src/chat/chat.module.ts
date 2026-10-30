import { Module, type DynamicModule } from '@nestjs/common';
import { LOGGER, PgDb, type PgDbOptions } from '@foc/platform';
import { env } from '../config.js';
import { CHAT_DB } from '../db/db.js';
import { ChatController } from './chat.controller.js';
import { ChatRepository } from './chat.repository.js';
import { ChatService } from './chat.service.js';
import { UPSTREAM_FETCH, Upstreams } from './upstreams.js';

@Module({})
export class ChatModule {
  static forRoot(): DynamicModule {
    return {
      module: ChatModule,
      controllers: [ChatController],
      providers: [
        ChatService,
        ChatRepository,
        Upstreams,
        { provide: UPSTREAM_FETCH, useValue: fetch },
        {
          provide: CHAT_DB,
          useFactory: (logger: PgDbOptions['logger']) => new PgDb(env.DATABASE_URL, { logger }),
          inject: [LOGGER],
        },
      ],
    };
  }
}
