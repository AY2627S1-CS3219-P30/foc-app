import { WsAdapter } from '@nestjs/platform-ws';
import type { Server, WebSocket } from 'ws';

/**
 * #369 — the chat socket's transport. Nest's adapter logs every socket error at ERROR with its
 * stack, but a socket's own errors are a client breaking the WebSocket protocol (a reserved opcode,
 * an unmasked frame, more than `maxPayload`), which any client can send. ws has already closed such
 * a socket with the matching code (1002, 1007 or 1009), so each is logged once at WARN, with ws's
 * code and no stack. The server's own errors stay at ERROR.
 */
export class ChatWsAdapter extends WsAdapter {
  override bindErrorHandler(server: Server): Server {
    server.on('connection', (socket: WebSocket) =>
      socket.on('error', (err: Error & { code?: string }) =>
        this.logger.warn({
          code: err.code,
          reason: err.message,
          msg: 'chat socket closed: the client broke the WebSocket protocol',
        }),
      ),
    );
    server.on('error', (err) => this.logger.error(err));
    return server;
  }
}
