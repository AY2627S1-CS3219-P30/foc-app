"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "../auth";
import { ORDER_SERVICE_URL } from "../order-api";
import { LiveConnection, type LiveConnectionOptions, type LiveStatus } from "./connection";
import type { SseEvent } from "./sse";

/**
 * A nudge from the live-update stream (N1.4, ADR 0011): never the errand itself, only that
 * something a page shows has changed, so the page reads it again through the ordinary API.
 *
 * - `ready`: the stream (re)opened; read everything shown, to catch up.
 * - `errand`: one of the caller's errands changed; `version` is its version after the change.
 * - `board`: an errand joined or left the open list.
 */
export type LiveNudge =
  | { kind: "ready" }
  | { kind: "board" }
  | { kind: "errand"; orderId: string; version?: number };

type Connection = Pick<LiveConnection, "start" | "stop" | "retryNow">;
export type Connect = (handlers: Pick<LiveConnectionOptions, "authed" | "onEvent" | "onStatus">) => Connection;

const connectToOrderService: Connect = (handlers) =>
  new LiveConnection({ url: ORDER_SERVICE_URL && `${ORDER_SERVICE_URL}/live`, ...handlers });

type Live = { status: LiveStatus; listen: (listener: (nudge: LiveNudge) => void) => () => void };
const LiveContext = createContext<Live | null>(null);

/** An event the stream sent, as a nudge; `null` for one this page does not know, or cannot read. */
function toNudge({ event, data }: SseEvent): LiveNudge | null {
  if (event === "ready" || event === "board") return { kind: event };
  if (event !== "errand") return null;
  try {
    const { orderId, version } = JSON.parse(data) as { orderId?: unknown; version?: unknown };
    if (typeof orderId !== "string") return null;
    return typeof version === "number" ? { kind: "errand", orderId, version } : { kind: "errand", orderId };
  } catch {
    return null;
  }
}

/**
 * The tab's one live-update stream, shared by every page in it. Closed while the tab is hidden, as
 * polling pauses then, and opened again on return; tried again at once when the network is back.
 * Off (`enabled={false}`), nothing is opened and pages only poll, as they always did.
 */
export function LiveProvider({
  children,
  enabled = true,
  connect = connectToOrderService,
}: {
  children: ReactNode;
  enabled?: boolean;
  connect?: Connect;
}) {
  const { authed } = useAuth();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const listeners = useRef(new Set<(nudge: LiveNudge) => void>());

  useEffect(() => {
    if (!enabled) return;
    const connection = connect({
      authed,
      onStatus: setStatus,
      onEvent: (event) => {
        const nudge = toNudge(event);
        if (nudge) for (const listener of [...listeners.current]) listener(nudge);
      },
    });
    const visibility = () =>
      document.visibilityState === "hidden" ? connection.stop() : connection.start();
    const online = () => connection.retryNow();
    if (document.visibilityState !== "hidden") connection.start();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", online);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
      connection.stop();
    };
  }, [enabled, authed, connect]);

  const listen = useCallback((listener: (nudge: LiveNudge) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);
  const value = useMemo(() => (enabled ? { status, listen } : null), [enabled, status, listen]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

/** Calls `listener` with each nudge while mounted; nothing outside a `LiveProvider`. */
export function useLive(listener: (nudge: LiveNudge) => void): void {
  const listen = useContext(LiveContext)?.listen;
  const onNudge = useEffectEvent(listener);
  useEffect(() => listen?.((nudge) => onNudge(nudge)), [listen]);
}

/** What to tell the user about live updates, or `null` where there are none. */
export function useLiveStatus(): LiveStatus | null {
  return useContext(LiveContext)?.status ?? null;
}

/**
 * How long a courier's feed waits before reading the open list on `board`: up to a second, so the
 * feeds open at that moment do not all read it at once.
 */
export function boardReadDelay(random: () => number = Math.random): number {
  return Math.floor(random() * 1_000);
}
