// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-11-06 to 2026-11-07
// Scope: Generated the initial implementation for "quieter protocol errors, a cap on unsigned
//   sockets, a 60 s socket refusal" (#369, #370, #371); later bug fixes.
// Author review: Jonus Ho verified correctness, tested the change, and checked for fatal errors and
//   conflicts with our architecture before committing.

import type { IncomingMessage } from 'node:http';
import type { INestApplicationContext } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { METRICS, type Metrics } from '@foc/platform';
import type { Server, WebSocket } from 'ws';

/** At most one protocol error is logged in this long; the rest are counted, and summed in the next. */
const LOG_EVERY_MS = 60_000;

/**
 * #369 — the chat socket's transport. Nest's adapter logs every socket error at ERROR with its
 * stack, but a socket's own errors are a client breaking the WebSocket protocol (a reserved opcode,
 * an unmasked frame, more than `maxPayload`), which any client can send. ws has already closed such
 * a socket with the matching code (1002, 1007 or 1009). So each is counted, by ws's error code, and
 * logged at WARN without a stack, at most once a minute, so a client that loops on bad frames
 * cannot flood the log. The server's own errors stay at ERROR.
 */
export class ChatWsAdapter extends WsAdapter {
  private readonly protocolErrors;
  private lastLogged = Number.NEGATIVE_INFINITY;
  private notLogged = 0;

  constructor(app: INestApplicationContext) {
    super(app);
    this.protocolErrors = app.get<Metrics>(METRICS).addCounter({
      name: 'foc_chat_socket_protocol_errors_total',
      help: 'Chat sockets closed for breaking the WebSocket protocol, by ws error code.',
      labelNames: ['code'],
    });
  }

  override bindErrorHandler(server: Server): Server {
    server.on('connection', (socket: WebSocket, request: IncomingMessage) =>
      socket.on('error', (err: Error & { code?: string }) => this.protocolError(err, request)),
    );
    server.on('error', (err) => this.logger.error(err));
    return server;
  }

  private protocolError(err: Error & { code?: string }, request: IncomingMessage): void {
    this.protocolErrors.inc({ code: err.code ?? 'unknown' });
    const now = Date.now();
    if (now - this.lastLogged < LOG_EVERY_MS) {
      this.notLogged += 1;
      return;
    }
    this.logger.warn({
      code: err.code,
      reason: err.message,
      // The edge's, so the sender can be found in its access log.
      correlationId: request.headers['x-correlation-id'],
      notLoggedInTheLastMinute: this.notLogged,
      msg: 'chat socket closed: the client broke the WebSocket protocol',
    });
    this.lastLogged = now;
    this.notLogged = 0;
  }
}
