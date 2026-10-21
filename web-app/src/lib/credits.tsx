"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import { getMyWallet } from "./order-api";
import { usePoll } from "./use-poll";

const CREDITS_POLL_MS = 30_000;

type Credits = {
  /** The available balance, or `null` until it is first read. */
  available: number | null;
  /** Reads it again now, after something that may have moved credits. */
  refresh: () => void;
};

const CreditsContext = createContext<Credits | null>(null);

/**
 * The student's available balance, read once for every screen rather than by each one. Credits move
 * on the server (reservations, releases, payouts), so it is read again on a timer and on return. It
 * is advice, so a failed read keeps the last balance rather than hiding it.
 */
export function CreditsProvider({ children }: { children: ReactNode }) {
  const { authed } = useAuth();
  const [available, setAvailable] = useState<number | null>(null);
  const read = useCallback(
    async (signal: AbortSignal) => {
      try {
        const wallet = await authed((token) => getMyWallet(token, signal));
        if (!signal.aborted) setAvailable(wallet.available);
      } catch {
        // Keep the last balance: one failed read says nothing about it.
      }
      return CREDITS_POLL_MS;
    },
    [authed],
  );
  const refresh = usePoll(read);
  const value = useMemo(() => ({ available, refresh }), [available, refresh]);
  return <CreditsContext.Provider value={value}>{children}</CreditsContext.Provider>;
}

export function useCredits() {
  const ctx = useContext(CreditsContext);
  if (!ctx) throw new Error("useCredits must be used within CreditsProvider");
  return ctx;
}
