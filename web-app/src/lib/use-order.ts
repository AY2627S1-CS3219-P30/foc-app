"use client";

import { useCallback, useRef, useState } from "react";
import { ApiError } from "./api-client";
import { useAuth } from "./auth";
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
/** Settled polling stops this long after the status last changed, the tab last woke or a refresh. */
const IDLE_LIMIT_MS = 10 * 60_000;

/**
 * Reads the order, and keeps reading until it reaches a final state: often while credits move,
 * every 30 seconds otherwise. Settled polling also pauses after ten minutes without a change, until
 * the tab is shown, back online or refreshed; `paused` says so meanwhile, since a tab that stays
 * visible never wakes it. A 4xx, or an error that is not an {@link ApiError} (a bug, not the
 * network), stops without pausing, as `problem` shows it, and a 404 drops the errand so its actions
 * go with it.
 * `skew` is how far this device's clock runs ahead of the server's, from the order's `serverTime`.
 */
export function useOrder(orderId: string) {
  const { authed } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [skew, setSkew] = useState(0);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [stillWaiting, setStillWaiting] = useState(false);
  const [paused, setPaused] = useState(false);
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

  /** Until the next read: backing off while credits move, `null` (and paused) once settled polling goes idle. */
  const nextDelay = useCallback(() => {
    if (!status.current || waitsOnCredit(status.current))
      return PENDING_DELAYS_MS[Math.min(attempt.current++, PENDING_DELAYS_MS.length - 1)];
    const idle = Date.now() - since.current >= IDLE_LIMIT_MS;
    setPaused(idle);
    return idle ? null : SETTLED_DELAY_MS;
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
  /** Gives settled polling another ten minutes. Every read after a pause starts here. */
  const wake = useCallback(() => {
    since.current = Date.now();
    setPaused(false);
  }, []);
  useOnReturn(wake);

  /** Shows `latest` (a command's answer) at once, then reads again, resuming paused polling. */
  const refresh = useCallback(
    (latest?: Order) => {
      if (latest) show(latest);
      wake();
      readNow();
    },
    [readNow, show, wake],
  );

  return { order, skew, problem, stillWaiting, paused, refresh };
}
