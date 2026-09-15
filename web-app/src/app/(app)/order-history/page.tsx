"use client";

import { useMemo } from "react";
import { AppBar } from "@/components/AppBar";
import { DesktopShell } from "@/components/DesktopShell";
import { ErrandCard } from "@/components/ErrandCard";
import { Screen, ScreenContent } from "@/components/Screen";
import { STUDENT_NAV } from "@/lib/nav";
import { useStore } from "@/lib/store";
import { CURRENT_USER } from "@/lib/types";

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
    <p style={{ color: "var(--color-text-subtle)", fontSize: 14 }}>
      You haven&apos;t requested or fulfilled any errands yet.
    </p>
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
              gap: 16,
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
