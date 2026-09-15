"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/Button";
import { DesktopShell } from "@/components/DesktopShell";
import { PersonRow } from "@/components/PersonRow";
import { Screen, ScreenContent } from "@/components/Screen";
import { STUDENT_NAV } from "@/lib/nav";
import { useStore } from "@/lib/store";
import { CURRENT_USER } from "@/lib/types";

export default function ProfilePage() {
  const { state, logout } = useStore();
  const router = useRouter();

  const stats = useMemo(() => {
    const mine = state.requests.filter((r) => r.requesterId === CURRENT_USER.id);
    const delivered = state.requests.filter(
      (r) => r.courierId === CURRENT_USER.id && r.status === "complete"
    );
    return {
      posted: mine.length,
      delivered: delivered.length,
    };
  }, [state.requests]);

  function handleLogout() {
    logout();
    router.push("/login");
  }

  const body = (
    <>
      <div className="card">
        <PersonRow name={CURRENT_USER.name} location="NUS student" />
      </div>
      <div className="card" style={{ display: "flex", gap: 24, marginTop: 12 }}>
        <div>
          <p style={{ fontSize: 12, color: "var(--color-text-subtle)" }}>Requests posted</p>
          <p style={{ fontSize: 20, fontWeight: 700 }}>{stats.posted}</p>
        </div>
        <div>
          <p style={{ fontSize: 12, color: "var(--color-text-subtle)" }}>Errands delivered</p>
          <p style={{ fontSize: 20, fontWeight: 700 }}>{stats.delivered}</p>
        </div>
        <div>
          <p style={{ fontSize: 12, color: "var(--color-text-subtle)" }}>Balance</p>
          <p style={{ fontSize: 20, fontWeight: 700 }}>{state.balance}</p>
        </div>
      </div>
      <Button variant="subtle" onClick={handleLogout} style={{ marginTop: 16 }}>
        Log out
      </Button>
    </>
  );

  return (
    <>
      <div className="mobileOnly">
        <Screen>
          <AppBar title="Profile" />
          <ScreenContent>{body}</ScreenContent>
        </Screen>
      </div>
      <div className="desktopOnly">
        <DesktopShell navItems={STUDENT_NAV} activeHref="/profile" heading="Profile">
          {body}
        </DesktopShell>
      </div>
    </>
  );
}
