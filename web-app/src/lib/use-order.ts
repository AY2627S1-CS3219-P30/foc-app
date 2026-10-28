"use client";

import { useCallback, useRef, useState } from "react";
import { ApiError } from "./api-client";
import { useAuth } from "./auth";
import { useLive } from "./live/live";
import { getOrder, type Order, type OrderStatus } from "./order-api";
import { isFinal, waitsOnCredit } from "./order-status";
import { useOnReturn } from "./use-on-return";
import { usePoll } from "./use-poll";

/** Waits between reads while the Credit Service works: backing off, then every 15 seconds. */
const PENDING_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** Between reads while the errand waits on someone else, like a courier or its deadline. */
const SETTLED_DELAY_MS = 30_000;
/** After this long in any `*_PENDING_CREDIT` state, say it is slower than usual. */
const STILL_WAITING_MS = 30_000;
/** Settled polling stops this long after the status last changed or the tab last woke. */
const IDLE_LIMIT_MS = 10 * 60_000;

/**
 * Reads the order, and keeps reading until it reaches a final state: often while credits move,
 * every 30 seconds otherwise. Settled polling also pauses after ten minutes without a change, until
 * the tab is shown or back online. A 4xx, or an error that is not an {@link ApiError} (a bug, not
 * the network), stops, and a 404 drops the errand so its actions go with it.
 * `skew` is how far this device's clock runs ahead of the server's, from the order's `serverTime`.
 */
export function useOrder(orderId: string) {
  const { authed } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [skew, setSkew] = useState(0);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [stillWaiting, setStillWaiting] = useState(false);
  const status = useRef<OrderStatus | null>(null);
  const version = useRef(-1);
  const since = useRef(0);
  const attempt = useRef(0);

  const show = useCallback((next: Order) => {
    if (next.version < version.current) return;
    version.current = next.version;
    setOrder(next);
    setSkew(Date.now() - Date.parse(next.serverTime));
    setStillWaiting(
      waitsOnCredit(next.status) &&
        Date.parse(next.serverTime) - Date.parse(next.updatedAt) >= STILL_WAITING_MS,
    );
    if (next.status !== status.current) {
      status.current = next.status;
      since.current = Date.now();
      attempt.current = 0;
    }
  }, []);

  /** Until the next read: backing off while credits move, `null` once settled polling goes idle. */
  const nextDelay = useCallback(() => {
    if (!status.current || waitsOnCredit(status.current))
      return PENDING_DELAYS_MS[Math.min(attempt.current++, PENDING_DELAYS_MS.length - 1)];
    return Date.now() - since.current >= IDLE_LIMIT_MS ? null : SETTLED_DELAY_MS;
  }, []);

  const read = useCallback(
    async (signal: AbortSignal) => {
      if (status.current && isFinal(status.current)) return null;
      try {
        const next = await authed((token) => getOrder(token, orderId, signal));
        if (signal.aborted) return null;
        show(next);
        setProblem(null);
        return isFinal(next.status) ? null : nextDelay();
      } catch (err) {
        if (signal.aborted) return null;
        const problem =
          err instanceof ApiError ? err : new ApiError(0, "UNEXPECTED", "Something went wrong.");
        setProblem(problem);
        if (problem.status === 404) setOrder(null);
        const stop = problem.code === "UNEXPECTED" || (problem.status >= 400 && problem.status < 500);
        return stop ? null : nextDelay();
      }
    },
    [authed, orderId, show, nextDelay],
  );
  const readNow = usePoll(read);
  useOnReturn(() => {
    since.current = Date.now();
  });
  // N1.4: read again at once when the stream says this errand moved past what is shown. A courier
  // who withdrew or missed the pickup deadline is no longer named on it, so hears only that it went
  // back on the board.
  useLive((nudge) => {
    if (nudge.kind === "ready") readNow();
    else if (nudge.kind === "errand" && nudge.orderId === orderId) {
      if ((nudge.version ?? Number.POSITIVE_INFINITY) > version.current) readNow();
    } else if (nudge.kind === "board" && status.current === "ACCEPTED") readNow();
  });

  /** Shows `latest` (a command's answer) at once, then reads again. */
  const refresh = useCallback(
    (latest?: Order) => {
      if (latest) show(latest);
      readNow();
    },
    [readNow, show],
  );

  return { order, skew, problem, stillWaiting, refresh };
}
