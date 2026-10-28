"use client";

import { useEffect, useState } from "react";
import { useAuth } from "./auth";
import { getOrderHistory, type OrderHistory } from "./order-api";

type Read = { key: string; history: OrderHistory | null; error: string | null };

/** One read for both responsive views. Identity/order changes hide the previous private result immediately. */
export function useOrderHistory(orderId: string, version: number | undefined, participant: boolean) {
  const { authed, user } = useAuth();
  const key = `${user?.id ?? ""}:${orderId}`;
  const enabled = participant && !!user;
  const [read, setRead] = useState<Read | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void authed((token) => getOrderHistory(token, orderId, controller.signal))
      .then((history) => {
        if (!controller.signal.aborted) setRead({ key, history, error: null });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setRead({
            key,
            history: null,
            error: "The errand is still available. Try loading its history again.",
          });
      });
    return () => controller.abort();
  }, [authed, key, orderId, version, enabled, attempt]);
  const current = enabled && read?.key === key ? read : null;
  return {
    history: current?.history ?? null,
    error: current?.error ?? null,
    retry: () => setAttempt((value) => value + 1),
  };
}
