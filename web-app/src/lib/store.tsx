"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { INITIAL_BALANCE, INITIAL_LEDGER, INITIAL_RESERVED, INITIAL_REQUESTS } from "./mock-data";

/** The menu, and the wallet page's mock data until WEB-03. Sessions live in auth.tsx. */
const MOCK_WALLET = {
  requests: INITIAL_REQUESTS,
  ledger: INITIAL_LEDGER,
  balance: INITIAL_BALANCE,
  reserved: INITIAL_RESERVED,
};

type Store = {
  state: typeof MOCK_WALLET & { isMenuOpen: boolean };
  setMenuOpen: (open: boolean) => void;
};

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const value = useMemo(
    () => ({ state: { ...MOCK_WALLET, isMenuOpen }, setMenuOpen: setIsMenuOpen }),
    [isMenuOpen],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
