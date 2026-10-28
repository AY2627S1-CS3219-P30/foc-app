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
/** Settled polling stops this long after the status last changed, the tab last woke, a refresh or a deadline. */
const IDLE_LIMIT_MS = 10 * 60_000;
/** Read this long after a deadline, so this device's clock cannot run the read early. */
const DEADLINE_MARGIN_MS = 1_000;
/** `setTimeout` fires at once for longer delays, so a far deadline is waited for in steps. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** When the server changes the errand by itself unless someone acts first, on the server's clock. */
function serverDeadline(order: Order) {
  if (order.status === "OPEN") return order.acceptanceDeadlineAt;
  if (order.status === "DELIVERED") return order.autoConfirmAt;
  return null;
}

/**
 * Reads the order, and keeps reading until it reaches a final state: often while credits move,
 * every 30 seconds otherwise. Settled polling also goes idle after ten minutes without a change,
 * until the tab is shown, back online or refreshed, or until a deadline on which the server changes
 * the errand by itself, which wakes it for another ten minutes. `paused` says it is idle after a
 * read that worked, since a tab that stays visible never wakes it; it is never set with `problem`.
 * A 4xx, or an error that is not an {@link ApiError} (a bug, not the network), stops, and a 404
 * drops the errand so its actions go with it.
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
  /** The next server deadline on this device's clock, margin included. */
  const due = useRef<number | null>(null);

  const show = useCallback((next: Order) => {
    if (next.version < version.current) return;
    version.current = next.version;
    const skew = Date.now() - Date.parse(next.serverTime);
    setOrder(next);
    setSkew(skew);
    setStillWaiting(
      waitsOnCredit(next.status) &&
        Date.parse(next.serverTime) - Date.parse(next.updatedAt) >= STILL_WAITING_MS,
    );
    const deadline = serverDeadline(next);
    due.current = deadline ? Date.parse(deadline) + skew + DEADLINE_MARGIN_MS : null;
    if (next.status !== status.current) {
      status.current = next.status;
      since.current = Date.now();
      attempt.current = 0;
    }
  }, []);

  /**
   * Until the next read, and whether settled polling is idle: backing off while credits move, then
   * every 30 seconds until ten minutes after the last change or passed deadline, then only at the
   * next deadline, if one is coming.
   */
  const nextDelay = useCallback((): { delay: number | null; idle: boolean } => {
    if (!status.current || waitsOnCredit(status.current)) {
      const delay = PENDING_DELAYS_MS[Math.min(attempt.current++, PENDING_DELAYS_MS.length - 1)];
      return { delay, idle: false };
    }
    const now = Date.now();
    const deadline = due.current;
    const woke = deadline !== null && deadline <= now ? Math.max(since.current, deadline) : since.current;
    if (now - woke < IDLE_LIMIT_MS) return { delay: SETTLED_DELAY_MS, idle: false };
    const delay = deadline !== null && deadline > now ? Math.min(deadline - now, MAX_DELAY_MS) : null;
    return { delay, idle: true };
  }, []);

  const read = useCallback(
    async (signal: AbortSignal) => {
      if (status.current && isFinal(status.current)) return null;
      try {
        const next = await authed((token) => getOrder(token, orderId, signal));
        if (signal.aborted) return null;
        show(next);
        setProblem(null);
        const { delay, idle } = isFinal(next.status) ? { delay: null, idle: false } : nextDelay();
        setPaused(idle);
        return delay;
      } catch (err) {
        if (signal.aborted) return null;
        const problem =
          err instanceof ApiError ? err : new ApiError(0, "UNEXPECTED", "Something went wrong.");
        setProblem(problem);
        setPaused(false);
        if (problem.status === 404) setOrder(null);
        const stop = problem.code === "UNEXPECTED" || (problem.status >= 400 && problem.status < 500);
        return stop ? null : nextDelay().delay;
      }
    },
    [authed, orderId, show, nextDelay],
  );
  const readNow = usePoll(read);
  /** Gives settled polling another ten minutes. `paused` stays until the read that follows. */
  const wake = useCallback(() => {
    since.current = Date.now();
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
