"use client";

import { useEffect, useState } from "react";
import { ApiError } from "./api-client";
import { useAuth } from "./auth";
import { getOrder, type Order, type OrderStatus } from "./order-api";
import { isFinal } from "./order-status";

/** Waits between reads while the Credit Service works: backing off, then every 15 seconds. */
const PENDING_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** Between reads while the errand waits on someone else, like a courier or its deadline. */
const SETTLED_DELAY_MS = 30_000;
/** After this long in `PENDING_CREDIT`, say it is slower than usual. */
const STILL_WAITING_MS = 30_000;

const pollDelay = (status: OrderStatus | undefined, attempt: number) =>
  !status || status.endsWith("PENDING_CREDIT")
    ? PENDING_DELAYS_MS[Math.min(attempt, PENDING_DELAYS_MS.length - 1)]
    : SETTLED_DELAY_MS;

/**
 * Reads the order, and keeps reading until it reaches a final state: often while credits move,
 * every 30 seconds otherwise. A hidden tab pauses; showing the tab or coming back online reads at
 * once. A 4xx or an error that is not an {@link ApiError} (a bug, not the network) stops polling.
 */
export function useOrder(orderId: string) {
  const { authed } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [stillWaiting, setStillWaiting] = useState(false);

  useEffect(() => {
    let status: OrderStatus | undefined;
    let since = Date.now();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let live = true;

    async function read() {
      if (reading || (status && isFinal(status)) || document.visibilityState === "hidden") return;
      clearTimeout(timer);
      reading = true;
      try {
        const next = await authed((token) => getOrder(token, orderId));
        if (!live) return;
        setOrder(next);
        setProblem(null);
        if (next.status !== status) {
          status = next.status;
          since = Date.now();
          attempt = 0;
        }
        if (isFinal(next.status)) return;
      } catch (err) {
        if (!live) return;
        const problem =
          err instanceof ApiError ? err : new ApiError(0, "UNEXPECTED", "Something went wrong.");
        setProblem(problem);
        if (problem.code === "UNEXPECTED" || (problem.status >= 400 && problem.status < 500)) return;
      } finally {
        reading = false;
      }
      setStillWaiting(Date.now() - since >= STILL_WAITING_MS);
      timer = setTimeout(read, pollDelay(status, attempt++));
    }

    void read();
    window.addEventListener("online", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener("online", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [authed, orderId]);

  return { order, problem, stillWaiting };
}
