// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-30 to 2026-11-07
// Scope: Generated the initial implementation for "channels and messages for an errand" (NTH-02,
//   #162, NTH-03); later new features, refactoring and bug fixes.
// Author review: Anselm Long, Jonus Ho and Zhang Yuan validated the behaviour and the
//   implementation, checked for fatal errors, and confirmed it does not conflict with the
//   architecture before committing.

import { Module, type DynamicModule } from '@nestjs/common';
import { LOGGER, PgDb, type PgDbOptions } from '@foc/platform';
import { env } from '../config.js';
import { CHAT_DB } from '../db/db.js';
import { ChatController } from './chat.controller.js';
import { ChatRepository } from './chat.repository.js';
import { ChatService } from './chat.service.js';
import { SOCKET_OPTIONS, SocketHub, type SocketOptions } from './socket/socket-hub.js';
import { SocketGateway } from './socket/socket.gateway.js';
import { RETENTION_OPTIONS, RetentionCleanup } from './retention.js';
import { UPSTREAM_FETCH, Upstreams } from './upstreams.js';

/** Sockets one instance holds, signed in or not. */
const SOCKETS_PER_INSTANCE = 1_000;

const socketOptions: SocketOptions = {
  authTimeoutMs: env.CHAT_SOCKET_AUTH_TIMEOUT_MS,
  recheckMs: env.CHAT_SOCKET_RECHECK_MS,
  // Well inside the edge's 75 s read timeout, so a quiet socket is never cut.
  pingMs: 25_000,
  perUser: 5,
  perInstance: SOCKETS_PER_INSTANCE,
  // #370: a tenth of the instance may wait to sign in, each for CHAT_SOCKET_AUTH_TIMEOUT_MS at most.
  // When all are waiting, a new socket pushes out the oldest still without an auth frame.
  pendingPerInstance: SOCKETS_PER_INSTANCE / 10,
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
        RetentionCleanup,
        {
          provide: RETENTION_OPTIONS,
          useValue: {
            retentionDays: env.CHAT_RETENTION_DAYS,
            intervalMs: env.CHAT_CLEANUP_INTERVAL_MS,
            retryMs: env.CHAT_CLEANUP_RETRY_MS,
          },
        },
        { provide: UPSTREAM_FETCH, useValue: fetch },
        {
          provide: CHAT_DB,
          useFactory: (logger: PgDbOptions['logger']) => new PgDb(env.DATABASE_URL, { logger }),
          inject: [LOGGER],
        },
      ],
      exports: [SocketHub],
    };
  }
}
