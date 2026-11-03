import { Module, type DynamicModule } from '@nestjs/common';
import { LOGGER, PgDb, type PgDbOptions } from '@foc/platform';
import { env } from '../config.js';
import { CHAT_DB } from '../db/db.js';
import { ChatController } from './chat.controller.js';
import { ChatRepository } from './chat.repository.js';
import { ChatService } from './chat.service.js';
import { SOCKET_OPTIONS, SocketHub, type SocketOptions } from './socket/socket-hub.js';
import { SocketGateway } from './socket/socket.gateway.js';
import { UPSTREAM_FETCH, Upstreams } from './upstreams.js';

const socketOptions: SocketOptions = {
  authTimeoutMs: env.CHAT_SOCKET_AUTH_TIMEOUT_MS,
  recheckMs: env.CHAT_SOCKET_RECHECK_MS,
  // Well inside the edge's 75 s read timeout, so a quiet socket is never cut.
  pingMs: 25_000,
  perUser: 5,
  perInstance: 1_000,
};

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
        SocketHub,
        { provide: SOCKET_OPTIONS, useValue: socketOptions },
        // Off, nothing handles an upgrade, so every socket is refused and the panel keeps polling.
        ...(env.CHAT_SOCKET_ENABLED ? [SocketGateway] : []),
        { provide: UPSTREAM_FETCH, useValue: fetch },
        {
          provide: CHAT_DB,
          useFactory: (logger: PgDbOptions['logger']) => new PgDb(env.DATABASE_URL, { logger }),
          inject: [LOGGER],
        },
      ],
      exports: [ChatRepository, Upstreams, SocketHub],
    };
  }
}
