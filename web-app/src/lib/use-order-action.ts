"use client";

import { useState } from "react";
import { ApiError } from "./api-client";
import { useAuth } from "./auth";
import { sendCommand, type Order } from "./order-api";
import { staleMessage, type OrderAction } from "./order-actions";

type Pending = { target: Pick<Order, "orderId" | "version">; action: OrderAction };

/**
 * One path for every errand command: ask, confirm, send with the version on screen. A refusal
 * because the errand moved on closes the dialog and hands `onStale` what to say, so the caller
 * re-reads instead of leaving a dead button. Anything else stays in the dialog to try again.
 */
export function useOrderAction({
  onDone,
  onStale,
}: {
  onDone: (order: Order) => void;
  onStale: (message: string) => void;
}) {
  const { authed } = useAuth();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function ask(target: Pending["target"], action: OrderAction) {
    setError(null);
    setPending({ target, action });
  }

  function close() {
    if (!busy) setPending(null);
  }

  async function confirm() {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      const order = await authed((token) => sendCommand(token, pending.action.command, pending.target));
      setPending(null);
      onDone(order);
    } catch (err) {
      const stale = err instanceof ApiError ? staleMessage(err) : null;
      if (stale) {
        setPending(null);
        onStale(stale);
      } else {
        setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return { action: pending?.action ?? null, busy, error, ask, close, confirm };
}

export type OrderActionState = ReturnType<typeof useOrderAction>;
