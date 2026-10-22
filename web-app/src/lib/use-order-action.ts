"use client";

import { useRef, useState } from "react";
import { ApiError } from "./api-client";
import { useAuth } from "./auth";
import { getOrder, sendCommand, type Order } from "./order-api";
import { staleMessage, tookEffect, type OrderAction } from "./order-actions";

type Pending = { target: Pick<Order, "orderId" | "version">; action: OrderAction };

const sendKey = ({ target, action }: Pending) => `${action.command} ${target.orderId} ${target.version}`;

/**
 * One path for every errand command: ask, confirm, send with the version on screen. A refusal
 * because the errand moved on closes the dialog and hands `onStale` what to say, so the caller
 * re-reads instead of leaving a dead button. Anything else stays in the dialog to try again. If an
 * earlier send of the same command never got an answer, a refusal may only mean it went through,
 * so the errand is read first, and if it shows the command took effect, that counts as done.
 */
export function useOrderAction({
  onDone,
  onStale,
}: {
  onDone: (order: Order) => void;
  onStale: (message: string) => void;
}) {
  const { authed, user } = useAuth();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unanswered = useRef<string | null>(null);

  function ask(target: Pending["target"], action: OrderAction) {
    setError(null);
    setPending({ target, action });
  }

  function close() {
    if (!busy) setPending(null);
  }

  async function confirm() {
    if (!pending || busy) return;
    const { target, action } = pending;
    setBusy(true);
    setError(null);
    try {
      const order = await authed((token) => sendCommand(token, action.command, target));
      setPending(null);
      onDone(order);
    } catch (err) {
      const stale = err instanceof ApiError ? staleMessage(err) : null;
      if (stale) {
        const latest =
          unanswered.current === sendKey(pending)
            ? await authed((token) => getOrder(token, target.orderId)).catch(() => null)
            : null;
        setPending(null);
        if (latest && tookEffect(action.command, latest, user?.id)) onDone(latest);
        else onStale(stale);
      } else {
        if (err instanceof ApiError && err.status === 0) unanswered.current = sendKey(pending);
        setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return { action: pending?.action ?? null, busy, error, ask, close, confirm };
}

export type OrderActionState = ReturnType<typeof useOrderAction>;
