// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-21 to 2026-11-04
// Scope: Generated the initial implementation for "take errands from post to paid in the app"
//   (WEB-02, WEB-05, #268); later bug fixes and new features.
// Author review: Patrick Thomas and Zhang Yuan checked the code for correctness against the ticket,
//   confirmed the tests pass, and made sure it caused no fatal errors or architectural conflicts
//   before committing.

"use client";

import { useRef, useState } from "react";
import { ApiError, newCorrelationId } from "./api-client";
import { useAuth } from "./auth";
import { sendCommand, type Order } from "./order-api";
import { staleMessage, type OrderAction } from "./order-actions";

/** `key` is the send's: every retry of it sends the same one, so the server answers it once. */
type Pending = { target: Pick<Order, "orderId" | "version">; action: OrderAction; key: string };

/**
 * One path for every errand command: ask, confirm, send with the version on screen. A refusal
 * because the errand moved on closes the dialog and hands `onStale` what to say, so the caller
 * re-reads instead of leaving a dead button. Anything else stays in the dialog to try again. The
 * same command at the same version always goes with the same key, even after the dialog is closed
 * and opened again, so a retry of a send whose answer was lost is answered as done, not refused. A
 * refusal records nothing on the server, and a success moves the version on, so reuse is safe.
 */
export function useOrderAction({
  onDone,
  onStale,
}: {
  onDone: (order: Order) => void;
  onStale: (message: string, orderId: string) => void;
}) {
  const { authed } = useAuth();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());

  function ask(target: Pending["target"], action: OrderAction) {
    setError(null);
    const send = `${action.command} ${target.orderId} ${target.version}`;
    const key = keys.current.get(send) ?? newCorrelationId();
    keys.current.set(send, key);
    setPending({ target, action, key });
  }

  function close() {
    if (!busy) setPending(null);
  }

  async function confirm() {
    if (!pending || busy) return;
    const { target, action, key } = pending;
    setBusy(true);
    setError(null);
    try {
      const order = await authed((token) => sendCommand(token, action.command, target, key));
      setPending(null);
      onDone(order);
    } catch (err) {
      const stale = err instanceof ApiError ? staleMessage(err) : null;
      if (stale) {
        setPending(null);
        onStale(stale, target.orderId);
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
