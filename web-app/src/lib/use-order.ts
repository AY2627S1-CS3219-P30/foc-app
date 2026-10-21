"use client";

import { useCallback, useRef, useState } from "react";
import { ApiError } from "./api-client";
import { useAuth } from "./auth";
import { getOrder, type Order } from "./order-api";
import { isFinal } from "./order-status";
import { usePoll } from "./use-poll";

/** Waits between reads while the Credit Service has the errand: backing off, then every 15 seconds. */
const CREDIT_POLL_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** Between reads while the errand waits on a person. */
const ACTIVE_POLL_MS = 15_000;
/** After this long in `PENDING_CREDIT`, say it is slower than usual. */
const STILL_WAITING_MS = 30_000;

const awaitingCredit = (status: Order["status"]) => status.endsWith("PENDING_CREDIT");

/**
 * Reads the order, and keeps reading until it is final: quickly while the Credit Service has it,
 * slower otherwise. A 4xx, or an error that is not an {@link ApiError} (a bug, not the network), stops.
 * `skew` is how far this device's clock runs ahead of the server's, from the order's `serverTime`.
 */
export function useOrder(orderId: string) {
  const { authed } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [skew, setSkew] = useState(0);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [stillWaiting, setStillWaiting] = useState(false);
  const since = useRef<number | null>(null);
  const creditReads = useRef(0);

  const show = useCallback((next: Order) => {
    setOrder(next);
    setSkew(Date.now() - Date.parse(next.serverTime));
  }, []);

  const read = useCallback(
    async (signal: AbortSignal) => {
      since.current ??= Date.now();
      try {
        const next = await authed((token) => getOrder(token, orderId));
        if (signal.aborted) return null;
        show(next);
        setProblem(null);
        setStillWaiting(
          next.status === "PENDING_CREDIT" && Date.now() - since.current >= STILL_WAITING_MS,
        );
        if (isFinal(next.status)) return null;
        if (!awaitingCredit(next.status)) {
          creditReads.current = 0;
          return ACTIVE_POLL_MS;
        }
        return CREDIT_POLL_MS[Math.min(creditReads.current++, CREDIT_POLL_MS.length - 1)];
      } catch (err) {
        if (signal.aborted) return null;
        const problem =
          err instanceof ApiError ? err : new ApiError(0, "UNEXPECTED", "Something went wrong.");
        setProblem(problem);
        const stop = problem.code === "UNEXPECTED" || (problem.status >= 400 && problem.status < 500);
        return stop ? null : ACTIVE_POLL_MS;
      }
    },
    [authed, orderId, show],
  );
  const readNow = usePoll(read);

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
