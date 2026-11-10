// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-10-22
// Scope: Implementation for "account screens on the real User Service" (USR-05, WEB-01, WEB-02).
// Author review: Patrick Thomas and Anselm Long validated the behaviour and the implementation,
//   checked for fatal errors, and confirmed it does not conflict with the architecture before
//   committing.

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
