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
import { vars } from "@/styles/tokens";

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
    <p style={{ fontSize: vars.text.sm, color: vars.color.textSubtle }}>
      {state.reserved} credits held against {openCount} open errand{openCount === 1 ? "" : "s"}
    </p>
  );

  const activity = (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: `0 ${vars.space[4]}` }}>
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
            <p style={{ fontSize: vars.text.lg, fontWeight: vars.weight.semibold, marginTop: vars.space[2] }}>
              Recent activity
            </p>
            {activity}
          </ScreenContent>
        </Screen>
      </div>

      <div className="desktopOnly">
        <DesktopShell navItems={STUDENT_NAV} activeHref="/wallet" heading="Wallet">
          <div style={{ display: "flex", flexWrap: "wrap", gap: vars.space[5], alignItems: "flex-start" }}>
            <div style={{ width: 320, flexShrink: 0, display: "flex", flexDirection: "column", gap: vars.space[2] }}>
              <WalletBalance available={state.balance} reserved={state.reserved} earnedThisWeek={earnedThisWeek} />
              {reservedHint}
            </div>
            <div style={{ flex: "1 1 320px", maxWidth: 480 }}>
              <p style={{ fontSize: vars.text.lg, fontWeight: vars.weight.semibold, marginBottom: vars.space[2] }}>
                Recent activity
              </p>
              {activity}
            </div>
          </div>
        </DesktopShell>
      </div>
    </>
  );
}
