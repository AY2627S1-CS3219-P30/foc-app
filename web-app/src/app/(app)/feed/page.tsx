"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/Button";
import { DesktopShell } from "@/components/DesktopShell";
import { ErrandCard } from "@/components/ErrandCard";
import { Screen, ScreenContent } from "@/components/Screen";
import { STUDENT_NAV } from "@/lib/nav";
import { useStore } from "@/lib/store";
import { CURRENT_USER } from "@/lib/types";

export default function FeedPage() {
  const { state, acceptRequest } = useStore();
  const router = useRouter();

  const openRequests = useMemo(
    () =>
      state.requests
        .filter((r) => r.status === "open" && r.requesterId !== CURRENT_USER.id)
        .sort((a, b) => b.createdAt - a.createdAt),
    [state.requests]
  );

  const empty = (
    <p style={{ color: "var(--color-text-subtle)", fontSize: 14 }}>
      No open errands right now — check back soon.
    </p>
  );

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <AppBar title="Feed" onPlusClick={() => router.push("/request/new")} />
          <ScreenContent>
            {openRequests.map((r) => (
              <ErrandCard key={r.id} request={r} onAccept={acceptRequest} />
            ))}
            {openRequests.length === 0 && empty}
          </ScreenContent>
        </Screen>
      </div>

      <div className="desktopOnly">
        <DesktopShell
          navItems={STUDENT_NAV}
          activeHref="/feed"
          heading="Open errands"
          actions={
            <Button onClick={() => router.push("/request/new")}>New request</Button>
          }
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: 16,
            }}
          >
            {openRequests.map((r) => (
              <ErrandCard key={r.id} request={r} onAccept={acceptRequest} />
            ))}
          </div>
          {openRequests.length === 0 && empty}
        </DesktopShell>
      </div>
    </>
  );
}
