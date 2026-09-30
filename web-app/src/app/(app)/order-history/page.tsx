"use client";

import { useMemo } from "react";
import { AppBar } from "@/components/AppBar";
import { DesktopShell } from "@/components/DesktopShell";
import { ErrandCard } from "@/components/ErrandCard";
import { Screen, ScreenContent } from "@/components/Screen";
import { EmptyState } from "@/components/States";
import { STUDENT_NAV } from "@/lib/nav";
import { useStore } from "@/lib/store";
import { CURRENT_USER } from "@/lib/types";
import { vars } from "@/styles/tokens";

export default function OrderHistoryPage() {
  const { state } = useStore();

  const myRequests = useMemo(
    () =>
      state.requests
        .filter((r) => r.requesterId === CURRENT_USER.id || r.courierId === CURRENT_USER.id)
        .sort((a, b) => b.createdAt - a.createdAt),
    [state.requests]
  );

  const empty = (
    <EmptyState title="No errands yet">
      Errands you request or deliver will show up here.
    </EmptyState>
  );

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <AppBar title="Order History" />
          <ScreenContent>
            {myRequests.map((r) => (
              <ErrandCard key={r.id} request={r} />
            ))}
            {myRequests.length === 0 && empty}
          </ScreenContent>
        </Screen>
      </div>

      <div className="desktopOnly">
        <DesktopShell navItems={STUDENT_NAV} activeHref="/order-history" heading="Order history">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: vars.space[4],
            }}
          >
            {myRequests.map((r) => (
              <ErrandCard key={r.id} request={r} />
            ))}
          </div>
          {myRequests.length === 0 && empty}
        </DesktopShell>
      </div>
    </>
  );
}
