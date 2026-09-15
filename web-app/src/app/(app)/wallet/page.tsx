"use client";

import { useMemo } from "react";
import { AppBar } from "@/components/AppBar";
import { DesktopShell } from "@/components/DesktopShell";
import { LedgerRow } from "@/components/LedgerRow";
import { Screen, ScreenContent } from "@/components/Screen";
import { WalletBalance } from "@/components/WalletBalance";
import { STUDENT_NAV } from "@/lib/nav";
import { useStore } from "@/lib/store";
import { CURRENT_USER } from "@/lib/types";

export default function WalletPage() {
  const { state } = useStore();

  const earnedThisWeek = useMemo(
    () =>
      state.ledger
        .filter((entry) => entry.type === "earned")
        .reduce((sum, entry) => sum + entry.amount, 0),
    [state.ledger]
  );

  const openCount = useMemo(
    () =>
      state.requests.filter((r) => r.requesterId === CURRENT_USER.id && r.status === "open")
        .length,
    [state.requests]
  );

  const reservedHint = state.reserved > 0 && (
    <p style={{ fontSize: 13, color: "var(--color-text-subtle)" }}>
      {state.reserved} credits held against {openCount} open errand{openCount === 1 ? "" : "s"}
    </p>
  );

  const activity = (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: "0 16px" }}>
        {state.ledger.map((entry) => (
          <LedgerRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <AppBar title="Wallet" />
          <ScreenContent>
            <WalletBalance available={state.balance} reserved={state.reserved} earnedThisWeek={earnedThisWeek} />
            {reservedHint}
            <p style={{ fontSize: 15, fontWeight: 600, marginTop: 8 }}>Recent activity</p>
            {activity}
          </ScreenContent>
        </Screen>
      </div>

      <div className="desktopOnly">
        <DesktopShell navItems={STUDENT_NAV} activeHref="/wallet" heading="Wallet">
          <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
            <div style={{ width: 320, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              <WalletBalance available={state.balance} reserved={state.reserved} earnedThisWeek={earnedThisWeek} />
              {reservedHint}
            </div>
            <div style={{ flex: 1, maxWidth: 480 }}>
              <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Recent activity</p>
              {activity}
            </div>
          </div>
        </DesktopShell>
      </div>
    </>
  );
}
