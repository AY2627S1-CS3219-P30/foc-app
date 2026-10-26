"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "./api-client";
import { useAuth } from "./auth";
import { getMyWallet, type Wallet } from "./order-api";
import { usePoll } from "./use-poll";

const CREDITS_POLL_MS = 30_000;

type Credits = {
  wallet: Wallet | null;
  problem: ApiError | null;
  available: number | null;
  /** Reads it again now, after something that may have moved credits. */
  refresh: () => void;
};

const CreditsContext = createContext<Credits | null>(null);

/**
 * The student's wallet, shared across screens. Credits move on the server (reservations, releases,
 * payouts), so it is read again on a timer and on return. A failed read keeps the last wallet.
 */
export function CreditsProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const { authed } = useAuth();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!enabled) return null;
      try {
        const next = await authed((token) => getMyWallet(token, signal));
        if (!signal.aborted) {
          setWallet(next);
          setProblem(null);
        }
      } catch (err) {
        if (!signal.aborted)
          setProblem(err instanceof ApiError ? err : new ApiError(0, "UNEXPECTED", "Something went wrong."));
      }
      return CREDITS_POLL_MS;
    },
    [authed, enabled],
  );
  const refresh = usePoll(read);
  const value = useMemo(
    () => ({ wallet, problem, available: wallet?.available ?? null, refresh }),
    [wallet, problem, refresh],
  );
  return <CreditsContext.Provider value={value}>{children}</CreditsContext.Provider>;
}

export function useCredits() {
  const ctx = useContext(CreditsContext);
  if (!ctx) throw new Error("useCredits must be used within CreditsProvider");
  return ctx;
}
