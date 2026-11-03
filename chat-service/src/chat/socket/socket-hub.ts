import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { AUTHENTICATOR, type Authenticator } from '@foc/auth-client';
import { METRICS, type Metrics } from '@foc/platform';

export const SOCKET_OPTIONS = Symbol('FOC_CHAT_SOCKET_OPTIONS');

export interface SocketOptions {
  /** A socket must send its auth frame within this long. */
  authTimeoutMs: number;
  /** An open socket's session is checked again this often. */
  recheckMs: number;
  /** The server pings this often; a socket that has not answered the previous ping is dropped. */
  pingMs: number;
  /** Open sockets one user may hold on this instance: one per tab. */
  perUser: number;
  /** Sockets this instance holds, open or not yet signed in, before it refuses more. */
  perInstance: number;
}

/** What the hub needs of a WebSocket: the gateway's `ws` client, or a test's fake. */
export interface Peer {
  send(frame: string): void;
  close(code: number, reason: string): void;
  ping(): void;
  terminate(): void;
}

/** A frame from the client, as the gateway parsed it. Only one kind is ever valid. */
export type Inbound = { type: 'auth'; token: string } | { type: 'malformed' };

/** What a new message is reported as: never its text, only how far the channel now goes. */
export interface Nudge {
  orderId: string;
  latestSeq: number;
}

/** Every way the server closes a socket, and what the client is told. */
export const CLOSE_REASONS = {
  'auth-timeout': { code: 4408, message: 'No auth frame in time.' },
  unauthenticated: { code: 4401, message: 'Not signed in, or the session has ended.' },
  'identity-changed': { code: 4401, message: 'The account changed. Sign in again.' },
  'too-many': { code: 4429, message: 'Too many chat sockets are open.' },
  'bad-frame': { code: 4400, message: 'Only one auth frame is accepted.' },
  shutdown: { code: 1001, message: 'The service is stopping.' },
} as const satisfies Record<string, { code: number; message: string }>;

export type CloseReason = keyof typeof CLOSE_REASONS;

/** How a socket ended: closed by the server for a reason, gone from the client, or unresponsive. */
type Ending = CloseReason | 'client-closed' | 'no-pong';

type Timer = ReturnType<typeof setTimeout>;

type SocketState =
  | { phase: 'awaiting-auth'; authTimer: Timer }
  | { phase: 'authenticating'; authTimer: Timer }
  | {
      phase: 'open';
      userId: string;
      sessionId: string;
      token: string;
      recheckTimer: Timer;
      expiryTimer: Timer | undefined;
    }
  | { phase: 'closed' };

/** One connection. The gateway holds it only to hand it back with each event. */
export interface ChatSocket {
  readonly peer: Peer;
  state: SocketState;
  /** Whether it has answered the last ping. */
  alive: boolean;
}

/** setTimeout fires at once for any delay beyond this. */
const MAX_TIMER_MS = 2_147_483_647;

const READY = JSON.stringify({ type: 'ready' });

/**
 * The `exp` claim of a JWT the authenticator has already verified, in epoch milliseconds, or
 * undefined when it has none that can be read.
 */
export function tokenExpiry(token: string): number | undefined {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    const exp = (payload as { exp?: unknown } | null)?.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * #346 — every chat socket on this instance, and what each new message sends to which of them.
 *
 * A socket says that something new arrived, never what (ADR 0012): the browser still reads through
 * `GET /channels/:id/messages`, where the live Order lookup decides access. So a socket that
 * outlives its right to the channel leaks at most a number. A socket signs in with its first frame,
 * using the same `authenticate` as every HTTP route, is checked again every `recheckMs`, and closes
 * at its token's expiry, when the account changes, and when the service stops.
 */
@Injectable()
export class SocketHub implements OnModuleDestroy {
  private readonly logger = new Logger(SocketHub.name);
  private readonly sockets = new Set<ChatSocket>();
  private readonly byUser = new Map<string, Set<ChatSocket>>();
  private readonly nudges;
  private readonly closes;
  private heartbeat?: ReturnType<typeof setInterval>;
  /** Set once the service starts to stop: a socket opened after the rest were closed would hold it up. */
  private stopping = false;

  constructor(
    @Inject(SOCKET_OPTIONS) private readonly options: SocketOptions,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
    @Inject(METRICS) metrics: Metrics,
  ) {
    metrics.addGauge({
      name: 'foc_chat_sockets',
      help: 'Chat sockets on this instance, signed in or not yet.',
      collect: (set) => set({}, this.sockets.size),
    });
    this.nudges = metrics.addCounter({
      name: 'foc_chat_socket_nudges_total',
      help: 'New-message nudges sent to chat sockets, one per socket.',
    });
    this.closes = metrics.addCounter({
      name: 'foc_chat_socket_closes_total',
      help: 'Chat sockets ended, by reason.',
      labelNames: ['reason'],
    });
  }

  /** A new connection. It is closed at once if this instance takes no more. */
  connect(peer: Peer): ChatSocket {
    const authTimer = setTimeout(
      () => this.end(socket, 'auth-timeout'),
      this.options.authTimeoutMs,
    );
    authTimer.unref();
    const socket: ChatSocket = { peer, state: { phase: 'awaiting-auth', authTimer }, alive: true };
    const refused = this.stopping
      ? 'shutdown'
      : this.sockets.size >= this.options.perInstance
        ? 'too-many'
        : undefined;
    this.sockets.add(socket);
    if (refused) {
      this.end(socket, refused);
      return socket;
    }
    this.heartbeat ??= setInterval(() => this.beat(), this.options.pingMs);
    this.heartbeat.unref();
    return socket;
  }

  /** A frame from the client: the first must sign in, and no other is ever accepted. */
  async received(socket: ChatSocket, frame: Inbound): Promise<void> {
    const { state } = socket;
    if (state.phase === 'closed') return;
    if (frame.type !== 'auth' || state.phase !== 'awaiting-auth') {
      return this.end(socket, 'bad-frame');
    }
    const authenticating: SocketState = { phase: 'authenticating', authTimer: state.authTimer };
    socket.state = authenticating;
    let userId: string;
    let sessionId: string;
    try {
      ({ userId, sessionId } = await this.authenticator.authenticate(`Bearer ${frame.token}`));
    } catch {
      if (socket.state === authenticating) this.end(socket, 'unauthenticated');
      return;
    }
    if (socket.state !== authenticating) return;
    this.open(socket, authenticating.authTimer, userId, sessionId, frame.token);
  }

  /** The client answered a ping. */
  pong(socket: ChatSocket): void {
    socket.alive = true;
  }

  /** The client went away. */
  disconnected(socket: ChatSocket): void {
    this.end(socket, 'client-closed');
  }

  /**
   * Tells every open socket of these users that the channel now goes up to `latestSeq`. Never
   * throws: a socket that cannot be written to is skipped, and the browser's poll covers it.
   */
  notify(userIds: readonly (string | null)[], nudge: Nudge): void {
    const frame = JSON.stringify({ type: 'messages', ...nudge });
    for (const userId of new Set(userIds)) {
      for (const socket of (userId && this.byUser.get(userId)) || []) {
        try {
          socket.peer.send(frame);
          this.nudges.inc();
        } catch (err) {
          this.logger.warn({
            orderId: nudge.orderId,
            reason: err instanceof Error ? err.message : String(err),
            msg: 'chat nudge dropped',
          });
        }
      }
    }
  }

  /**
   * A user's status or roles changed: close their sockets, so each signs in again and the User
   * Service decides afresh. Nothing is decided from the event itself.
   */
  identityChanged(userId: string): void {
    for (const socket of [...(this.byUser.get(userId) ?? [])]) this.end(socket, 'identity-changed');
  }

  /** Closes every socket, and refuses new ones, so the HTTP server can close without waiting. */
  onModuleDestroy(): void {
    this.stopping = true;
    for (const socket of [...this.sockets]) this.end(socket, 'shutdown');
  }

  private open(
    socket: ChatSocket,
    authTimer: Timer,
    userId: string,
    sessionId: string,
    token: string,
  ): void {
    clearTimeout(authTimer);
    const own = this.byUser.get(userId) ?? new Set<ChatSocket>();
    if (own.size >= this.options.perUser) return this.end(socket, 'too-many');
    const expiresAt = tokenExpiry(token);
    const untilExpiry = expiresAt === undefined ? undefined : expiresAt - Date.now();
    if (untilExpiry !== undefined && untilExpiry <= 0) return this.end(socket, 'unauthenticated');
    const expiryTimer =
      untilExpiry === undefined || untilExpiry > MAX_TIMER_MS
        ? undefined
        : setTimeout(() => this.end(socket, 'unauthenticated'), untilExpiry);
    expiryTimer?.unref();
    socket.state = {
      phase: 'open',
      userId,
      sessionId,
      token,
      recheckTimer: this.scheduleRecheck(socket),
      expiryTimer,
    };
    own.add(socket);
    this.byUser.set(userId, own);
    socket.peer.send(READY);
  }

  /** Asks again in `recheckMs` whether the socket's session still stands; closes it if not. */
  private scheduleRecheck(socket: ChatSocket): Timer {
    const timer = setTimeout(async () => {
      const state = socket.state;
      if (state.phase !== 'open') return;
      try {
        await this.authenticator.authenticate(`Bearer ${state.token}`);
      } catch {
        if (socket.state === state) this.end(socket, 'unauthenticated');
        return;
      }
      if (socket.state === state) state.recheckTimer = this.scheduleRecheck(socket);
    }, this.options.recheckMs);
    timer.unref();
    return timer;
  }

  private beat(): void {
    for (const socket of [...this.sockets]) {
      if (!socket.alive) {
        this.end(socket, 'no-pong');
        continue;
      }
      socket.alive = false;
      socket.peer.ping();
    }
  }

  /** The one way out of every phase. Safe to call again: a closed socket stays closed. */
  private end(socket: ChatSocket, ending: Ending): void {
    const { state } = socket;
    if (state.phase === 'closed') return;
    socket.state = { phase: 'closed' };
    if (state.phase === 'open') {
      clearTimeout(state.recheckTimer);
      clearTimeout(state.expiryTimer);
      const own = this.byUser.get(state.userId);
      own?.delete(socket);
      if (own?.size === 0) this.byUser.delete(state.userId);
    } else {
      clearTimeout(state.authTimer);
    }
    this.sockets.delete(socket);
    if (this.sockets.size === 0) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.closes.inc({ reason: ending });
    if (ending === 'no-pong') socket.peer.terminate();
    else if (ending !== 'client-closed') {
      const { code, message } = CLOSE_REASONS[ending];
      socket.peer.close(code, message);
    }
  }
}
