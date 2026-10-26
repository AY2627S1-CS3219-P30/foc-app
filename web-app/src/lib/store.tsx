"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/** The menu. Sessions live in auth.tsx, the balance in credits.tsx. */
type Store = {
  state: { isMenuOpen: boolean };
  setMenuOpen: (open: boolean) => void;
};

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const value = useMemo(() => ({ state: { isMenuOpen }, setMenuOpen: setIsMenuOpen }), [isMenuOpen]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
