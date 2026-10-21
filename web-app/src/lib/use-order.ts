"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api-client";
import { useAuth } from "./auth";
import { getOrder, type Order } from "./order-api";
import { isFinal } from "./order-status";
import { useOnReturn } from "./use-on-return";

/** Waits between reads while the Credit Service has the errand: backing off, then every 15 seconds. */
const CREDIT_POLL_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** Between reads while the errand waits on a person. */
const ACTIVE_POLL_MS = 15_000;
/** After this long in `PENDING_CREDIT`, say it is slower than usual. */
const STILL_WAITING_MS = 30_000;

const awaitingCredit = (status: Order["status"]) => status.endsWith("PENDING_CREDIT");

/**
 * Reads the order, and keeps reading until it is final while the tab is visible: quickly while
 * the Credit Service has it, slower otherwise. Coming back to the tab or back online reads it at
 * once. A 4xx, or an error that is not an {@link ApiError} (a bug, not the network), stops.
 */
export function useOrder(orderId: string) {
  const { authed } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [stillWaiting, setStillWaiting] = useState(false);
  const [revision, setRevision] = useState(0);
  const since = useRef<number | null>(null);

  /** Shows `latest` (a command's answer) at once, then reads again on the faster schedule. */
  const refresh = useCallback((latest?: Order) => {
    if (latest) setOrder(latest);
    setRevision((r) => r + 1);
  }, []);
  useOnReturn(refresh);

  useEffect(() => {
    since.current ??= Date.now();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;

    async function read() {
      if (document.visibilityState === "hidden") return;
      let delay = ACTIVE_POLL_MS;
      try {
        const next = await authed((token) => getOrder(token, orderId));
        if (!live) return;
        setOrder(next);
        setProblem(null);
        if (isFinal(next.status)) return;
        if (awaitingCredit(next.status))
          delay = CREDIT_POLL_MS[Math.min(attempt++, CREDIT_POLL_MS.length - 1)];
        setStillWaiting(
          next.status === "PENDING_CREDIT" && Date.now() - since.current! >= STILL_WAITING_MS,
        );
      } catch (err) {
        if (!live) return;
        const problem =
          err instanceof ApiError ? err : new ApiError(0, "UNEXPECTED", "Something went wrong.");
        setProblem(problem);
        if (problem.code === "UNEXPECTED" || (problem.status >= 400 && problem.status < 500)) return;
      }
      timer = setTimeout(read, delay);
    }

    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [authed, orderId, revision]);

  return { order, problem, stillWaiting, refresh };
}
