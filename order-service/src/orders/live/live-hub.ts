import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { METRICS, type Metrics, type OrderStatusChangedPayload } from '@foc/platform';

export const LIVE_OPTIONS = Symbol('FOC_LIVE_OPTIONS');

export interface LiveOptions {
  /** `LIVE_UPDATES_ENABLED`: off, every stream is refused and pages poll as they always did. */
  enabled: boolean;
  /** A stream ends itself after this long, so the page reconnects and authenticates again. */
  maxStreamMs: number;
  /** Streams one user may hold on this instance: one per open tab. */
  perUser: number;
  /** Streams this instance holds before it refuses more. */
  perInstance: number;
  /** A comment this often keeps an idle stream inside the edge's read timeout. */
  keepAliveMs: number;
  /** `board` is sent at most this often, however many errands join or leave it. */
  boardIntervalMs: number;
}

/** Where a stream's text goes: the HTTP response, or a test's buffer. */
export interface LiveSink {
  write(chunk: string): void;
  end(): void;
}

export type LiveRefusal = 'TOO_MANY_STREAMS' | 'LIVE_UNAVAILABLE';

/** Who an errand concerns: its requester and, once one has accepted, its courier. */
export interface Participants {
  requesterId: string;
  courierId: string | null;
}

interface Stream {
  userId: string;
  sink: LiveSink;
  lifetime?: ReturnType<typeof setTimeout>;
}

const READY = 'event: ready\ndata: {}\n\n';
const BOARD = 'event: board\ndata: {}\n\n';
const KEEP_ALIVE = ': keep-alive\n\n';

/**
 * N1.4 (#329) — live errand updates: the streams open on this instance, and what each status
 * change sends to which of them.
 *
 * A stream gets a nudge, never the errand. `errand` (its ID and version) goes to the errand's
 * requester and courier, the participant rule the API applies (OS-FR2.1.2); `board` goes to every
 * stream when an errand joins or leaves the open list, which every student can see anyway. The
 * page then reads again through the ordinary API, under its ordinary rules. So a lost, repeated or
 * reordered nudge costs at most one read, and a stream can never show what the API would not.
 */
@Injectable()
export class LiveHub implements OnModuleDestroy {
  private readonly logger = new Logger(LiveHub.name);
  private readonly streams = new Set<Stream>();
  private readonly byUser = new Map<string, Set<Stream>>();
  private readonly nudges;
  private readonly refusals;
  private keepAlive?: ReturnType<typeof setInterval>;
  private lastBoardAt = Number.NEGATIVE_INFINITY;
  private pendingBoard?: ReturnType<typeof setTimeout>;
  /** Set once the service starts to stop: a stream opened after the rest were ended would hold it up. */
  private stopping = false;

  constructor(
    @Inject(LIVE_OPTIONS) private readonly options: LiveOptions,
    @Inject(METRICS) metrics: Metrics,
  ) {
    metrics.addGauge({
      name: 'foc_live_streams',
      help: 'Live-update streams open on this instance.',
      collect: (set) => set({}, this.streams.size),
    });
    this.nudges = metrics.addCounter({
      name: 'foc_live_nudges_total',
      help: 'Nudges written to live-update streams, one per stream, by kind: errand or board.',
      labelNames: ['kind'],
    });
    this.refusals = metrics.addCounter({
      name: 'foc_live_refused_total',
      help: 'Live-update streams refused, by reason.',
      labelNames: ['reason'],
    });
  }

  /**
   * Opens a stream for `userId` and sends `ready`, or says why it may not. `close` is for when the
   * client goes; it is safe to call after the stream has ended itself.
   */
  open(userId: string, sink: LiveSink): { close(): void } | { refused: LiveRefusal } {
    const refused = this.refusal(userId);
    if (refused) {
      this.refusals.inc({ reason: refused });
      return { refused };
    }
    const stream: Stream = { userId, sink };
    stream.lifetime = setTimeout(() => this.release(stream, true), this.options.maxStreamMs);
    stream.lifetime.unref();
    this.streams.add(stream);
    const own = this.byUser.get(userId) ?? new Set<Stream>();
    own.add(stream);
    this.byUser.set(userId, own);
    this.keepAlive ??= setInterval(() => this.writeAll(KEEP_ALIVE), this.options.keepAliveMs);
    this.keepAlive.unref();
    sink.write(READY);
    return { close: () => this.release(stream, false) };
  }

  /**
   * One status change, as `order.status-changed` reports it. `participantsOf` reads the errand's
   * row; it is read only when a stream is open, and a failed read drops the nudge, since polling
   * covers it.
   */
  async changed(
    change: OrderStatusChangedPayload,
    participantsOf: (orderId: string) => Promise<Participants | undefined>,
  ): Promise<void> {
    if (this.streams.size === 0) return;
    if (change.previousStatus === 'OPEN' || change.newStatus === 'OPEN') this.board();

    let who: Participants | undefined;
    try {
      who = await participantsOf(change.orderId);
    } catch (err) {
      this.logger.warn({
        orderId: change.orderId,
        reason: err instanceof Error ? err.message : String(err),
        msg: 'live update dropped: the errand could not be read',
      });
      return;
    }
    if (!who) return;

    const version = change.orderVersion === undefined ? {} : { version: change.orderVersion };
    const frame = `event: errand\ndata: ${JSON.stringify({ orderId: change.orderId, ...version })}\n\n`;
    for (const userId of new Set([who.requesterId, who.courierId])) {
      for (const stream of (userId && this.byUser.get(userId)) || []) {
        stream.sink.write(frame);
        this.nudges.inc({ kind: 'errand' });
      }
    }
  }

  /** Ends every stream, and refuses new ones, so the HTTP server can close without waiting. */
  onModuleDestroy(): void {
    this.stopping = true;
    for (const stream of [...this.streams]) this.release(stream, true);
    clearTimeout(this.pendingBoard);
    this.pendingBoard = undefined;
  }

  private refusal(userId: string): LiveRefusal | undefined {
    if (!this.options.enabled || this.stopping || this.streams.size >= this.options.perInstance) {
      return 'LIVE_UNAVAILABLE';
    }
    if ((this.byUser.get(userId)?.size ?? 0) >= this.options.perUser) return 'TOO_MANY_STREAMS';
    return undefined;
  }

  /** At once, unless one went out within the interval; then once at its end, for the last change. */
  private board(): void {
    if (this.pendingBoard) return;
    const wait = this.lastBoardAt + this.options.boardIntervalMs - Date.now();
    if (wait <= 0) return this.sendBoard();
    this.pendingBoard = setTimeout(() => {
      this.pendingBoard = undefined;
      this.sendBoard();
    }, wait);
    this.pendingBoard.unref();
  }

  private sendBoard(): void {
    this.lastBoardAt = Date.now();
    this.writeAll(BOARD);
    this.nudges.inc({ kind: 'board' }, this.streams.size);
  }

  private writeAll(frame: string): void {
    for (const stream of this.streams) stream.sink.write(frame);
  }

  private release(stream: Stream, end: boolean): void {
    if (!this.streams.delete(stream)) return;
    clearTimeout(stream.lifetime);
    const own = this.byUser.get(stream.userId);
    own?.delete(stream);
    if (own?.size === 0) this.byUser.delete(stream.userId);
    if (this.streams.size === 0) {
      clearInterval(this.keepAlive);
      this.keepAlive = undefined;
    }
    if (end) stream.sink.end();
  }
}
