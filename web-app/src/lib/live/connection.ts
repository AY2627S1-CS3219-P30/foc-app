import { toApiError } from "../api-client";
import { sseParser, type SseEvent } from "./sse";

/**
 * What the page tells its user about live updates: `connecting` until the first answer (nothing is
 * shown), `live`, `reconnecting` after a drop, and `polling` when there is no stream and the page
 * reads on its timers, as it always did.
 */
export type LiveStatus = "connecting" | "live" | "reconnecting" | "polling";

/** The stream's own refusals: a page polls and asks again this much later. */
const REFUSED_RETRY_MS = 60_000;
const MAX_DELAY_MS = 10_000;

/**
 * How long to wait after the `failures`th failure in a row, counting from 0: 1, 2, 4 and 8 s, then
 * 10 s, each spread by up to a fifth either way so the tabs of a restarted service do not all come
 * back at once, and never past 10 s. With the `ready` read on reconnect, a dropped stream converges
 * within 10 s of the connection returning (WEB-04).
 */
export function reconnectDelay(failures: number, random: () => number = Math.random): number {
  const base = Math.min(1_000 * 2 ** failures, MAX_DELAY_MS);
  return Math.min(MAX_DELAY_MS, Math.round(base * (0.8 + 0.4 * random())));
}

type Timer = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

export type LiveConnectionOptions = {
  /** `${ORDER_SERVICE_URL}/live`, or `null` in a build without the Order Service's address. */
  url: string | null;
  /** The session's: runs a call with the access token, refreshing once on a 401. */
  authed: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
  onEvent(event: SseEvent): void;
  onStatus(status: LiveStatus): void;
  fetch?: typeof fetch;
  random?: () => number;
  timer?: Timer;
};

const browserTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One tab's live-update stream (N1.4, ADR 0011): opens it with the access token, passes on every
 * event, and opens it again when it ends or fails. It is read with `fetch`, not `EventSource`, which
 * cannot send an `Authorization` header; a token in the URL would be written to the edge's log.
 *
 * - The stream ends itself every five minutes: the reconnect that follows says nothing.
 * - From the second failure in a row the page says it is reconnecting, and from the fourth that it
 *   updates on its timers, while it keeps trying on the schedule above.
 * - The stream's own refusals, `429` and `503 LIVE_UNAVAILABLE` (too many streams, or switched
 *   off), leave the page polling and asking again a minute later. Anything else, the edge's `503`
 *   while the Order Service restarts included, is a drop.
 */
export class LiveConnection {
  private status: LiveStatus = "connecting";
  private failures = 0;
  private running = false;
  private controller?: AbortController;
  private retry?: unknown;
  private readonly send: typeof fetch;
  private readonly timer: Timer;

  constructor(private readonly options: LiveConnectionOptions) {
    this.send = options.fetch ?? ((input, init) => fetch(input, init));
    this.timer = options.timer ?? browserTimer;
  }

  /** Opens the stream, unless it is open already. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    void this.connect();
  }

  /** Closes the stream and gives up retrying, until `start`. */
  stop(): void {
    this.running = false;
    this.timer.clear(this.retry);
    this.retry = undefined;
    this.controller?.abort();
  }

  /** The network is back: try now rather than at the end of the backoff. A no-op while connected. */
  retryNow(): void {
    if (!this.running || this.retry === undefined) return;
    this.timer.clear(this.retry);
    this.retry = undefined;
    this.failures = 0;
    void this.connect();
  }

  private async connect(): Promise<void> {
    const { url } = this.options;
    if (url === null) return this.report("polling");
    const controller = new AbortController();
    this.controller = controller;
    let response: Response;
    try {
      response = await this.options.authed(async (token) => {
        const answer = await this.send(url, {
          headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
          cache: "no-store",
          signal: controller.signal,
        });
        // Thrown, so the session refreshes the token and calls again.
        if (answer.status === 401) throw toApiError(401, await answer.json().catch(() => null));
        return answer;
      });
    } catch {
      if (!controller.signal.aborted) this.failed();
      return;
    }
    if (response.ok && response.body) {
      await this.read(response.body, controller.signal);
      if (!controller.signal.aborted) this.failed();
      return;
    }
    const code = toApiError(response.status, await response.json().catch(() => null)).code;
    if (response.status === 429 || (response.status === 503 && code === "LIVE_UNAVAILABLE")) {
      this.report("polling");
      this.later(REFUSED_RETRY_MS);
      return;
    }
    this.failed();
  }

  private async read(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const feed = sseParser((event) => {
      if (event.event === "ready") {
        this.failures = 0;
        this.report("live");
      }
      this.options.onEvent(event);
    });
    signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        feed(decoder.decode(value, { stream: true }));
      }
    } catch {
      // A dropped connection ends the read like the end of the stream.
    }
  }

  private failed(): void {
    this.failures += 1;
    if (this.failures >= 4) this.report("polling");
    else if (this.failures >= 2) this.report("reconnecting");
    this.later(reconnectDelay(this.failures - 1, this.options.random));
  }

  private later(ms: number): void {
    if (!this.running) return;
    this.retry = this.timer.set(() => {
      this.retry = undefined;
      if (this.running) void this.connect();
    }, ms);
  }

  private report(status: LiveStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.options.onStatus(status);
  }
}

