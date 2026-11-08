// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-11-03
// Scope: Generated the initial implementation for "/socket gateway, first-frame sign-in, nudge on
//   send" (#346).
// Author review: Anselm Long verified correctness, tested the change, and checked for fatal errors
//   and conflicts with our architecture before committing.

import { Inject } from '@nestjs/common';
import { WebSocketGateway, type OnGatewayConnection } from '@nestjs/websockets';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';
import { SocketHub, type Inbound } from './socket-hub.js';

/** An auth frame is a token and a few bytes of JSON; anything longer is not one. */
export const MAX_FRAME_BYTES = 8 * 1024;

const authFrame = z.strictObject({
  type: z.literal('auth'),
  token: z.string().min(1).max(MAX_FRAME_BYTES),
});

/** One frame off the wire, as the hub understands it. */
export function parseFrame(data: RawData, isBinary: boolean): Inbound {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  if (isBinary || bytes.length > MAX_FRAME_BYTES) return { type: 'malformed' };
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { type: 'malformed' };
  }
  const parsed = authFrame.safeParse(json);
  return parsed.success ? parsed.data : { type: 'malformed' };
}

/**
 * #346 — `/socket` on the public port, which the edge serves at `/api/chat/socket`. The internal
 * port's server has no upgrade handler, so it takes no socket. Only the transport is here: each
 * frame is parsed and handed to the hub, which decides everything. Anything in the URL, a query
 * string included, is ignored: a socket signs in with its first frame or not at all.
 */
@WebSocketGateway({
  path: '/socket',
  // ws drops a larger frame itself; anything between this and MAX_FRAME_BYTES reaches the hub as
  // malformed, so the close codes stay the hub's.
  maxPayload: 2 * MAX_FRAME_BYTES,
})
export class SocketGateway implements OnGatewayConnection<WebSocket> {
  constructor(@Inject(SocketHub) private readonly hub: SocketHub) {}

  handleConnection(client: WebSocket): void {
    const socket = this.hub.connect({
      send: (frame) => client.send(frame),
      close: (code, reason) => client.close(code, reason),
      ping: () => client.ping(),
      terminate: () => client.terminate(),
    });
    client.on(
      'message',
      (data, isBinary) => void this.hub.received(socket, parseFrame(data, isBinary)),
    );
    client.on('pong', () => this.hub.pong(socket));
    client.on('close', () => this.hub.disconnected(socket));
  }
}
