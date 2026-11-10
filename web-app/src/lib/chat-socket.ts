// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-11-08
// Scope: Generated the initial implementation for "nudge the chat panel over the notify-only
//   socket" (#346).
// Author review: Patrick Thomas checked the code for correctness against the ticket, confirmed the
//   tests pass, and made sure it caused no fatal errors or architectural conflicts before
//   committing.

import { ApiError } from "./api-client";
import { browserTimer, reconnectDelay, type Timer } from "./live/connection";

export type ChatSocketOptions = {
  /** From {@link chatSocketUrl}; `null` in a build without the Chat Service's address. */
  url: string | null;
  /** The session's: runs a call with the access token, refreshing once on a 401. */
  authed: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
  /** True once the service says `ready`, false when that socket closes. */
  onLive(live: boolean): void;
  onMessages(orderId: string, latestSeq: number): void;
  WebSocket?: typeof WebSocket;
  random?: () => number;
  timer?: Timer;
};

/** `${base}/socket` on this page's origin when `base` is a path, on `ws:` or `wss:`. */
export function chatSocketUrl(base: string | null, page: string): string | null {
  if (base === null) return null;
  const url = new URL(`${base}/socket`, page);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function parse(data: unknown): { type?: unknown; orderId?: unknown; latestSeq?: unknown } | null {
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

/**
 * The notify-only chat socket (#346, ADR 0012; contract in `chat-service/README.md`). The token goes
 * in the first frame, never the URL. A `4401` before `ready` is thrown as a 401 so `authed` refreshes
 * the token and connects again; every other close, or a close after `ready`, reconnects on the
 * {@link reconnectDelay} schedule while the panel polls.
 */
export class ChatSocket {
  private running = false;
  private live = false;
  private failures = 0;
  private generation = 0;
  private socket?: WebSocket;
  private retry?: unknown;
  private readonly timer: Timer;

  constructor(private readonly options: ChatSocketOptions) {
    this.timer = options.timer ?? browserTimer;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.timer.clear(this.retry);
    this.retry = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000);
    this.report(false);
  }

  /** The network is back: try now rather than at the end of the backoff. */
  retryNow(): void {
    if (!this.running || this.retry === undefined) return;
    this.timer.clear(this.retry);
    this.retry = undefined;
    this.failures = 0;
    void this.connect();
  }

  private async connect(): Promise<void> {
    const { url } = this.options;
    if (url === null) return;
    const generation = this.generation;
    try {
      await this.options.authed((token) => this.open(url, token, generation));
    } catch {
      if (generation === this.generation) this.failed();
    }
  }

  /** Settles at `ready`, or when the socket closes before it. */
  private open(url: string, token: string, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (generation !== this.generation) return reject(new Error("Stopped"));
      const socket = new (this.options.WebSocket ?? WebSocket)(url);
      this.socket = socket;
      let ready = false;
      socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token }));
      socket.onmessage = ({ data }) => {
        if (socket !== this.socket) return;
        const frame = parse(data);
        if (frame?.type === "ready") {
          ready = true;
          this.failures = 0;
          this.report(true);
          resolve();
        } else if (
          frame?.type === "messages" &&
          typeof frame.orderId === "string" &&
          typeof frame.latestSeq === "number"
        )
          this.options.onMessages(frame.orderId, frame.latestSeq);
      };
      socket.onclose = ({ code }) => {
        if (!ready)
          return reject(
            code === 4401
              ? new ApiError(401, "UNAUTHENTICATED", "The chat socket refused the token.")
              : new Error(`Chat socket closed with ${code}`),
          );
        if (socket !== this.socket) return;
        this.socket = undefined;
        this.report(false);
        this.failed();
      };
    });
  }

  private failed(): void {
    this.failures += 1;
    if (!this.running) return;
    this.retry = this.timer.set(
      () => {
        this.retry = undefined;
        if (this.running) void this.connect();
      },
      reconnectDelay(this.failures - 1, this.options.random),
    );
  }

  private report(live: boolean): void {
    if (live === this.live) return;
    this.live = live;
    this.options.onLive(live);
  }
}

/** Opens the socket while the tab is visible, and tries again at once when the network is back. */
export function openWhileVisible(
  socket: Pick<ChatSocket, "start" | "stop" | "retryNow">,
): () => void {
  const visibility = () => (document.visibilityState === "hidden" ? socket.stop() : socket.start());
  const online = () => socket.retryNow();
  if (document.visibilityState !== "hidden") socket.start();
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("online", online);
  return () => {
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("online", online);
    socket.stop();
  };
}
