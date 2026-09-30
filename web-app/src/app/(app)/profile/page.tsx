"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/Button";
import { DesktopShell } from "@/components/DesktopShell";
import { ModeSwitch } from "@/components/ModeSwitch";
import { Screen, ScreenContent } from "@/components/Screen";
import { useAuth } from "@/lib/auth";
import { STUDENT_NAV } from "@/lib/nav";
import { ProfileForm } from "./ProfileForm";

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const router = useRouter();
  // The (app) layout only renders this once signed in.
  if (!user) return null;

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  const body = (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>Mode</h2>
        <p style={{ fontSize: 13, color: "var(--color-text-subtle)" }}>
          Switch between asking for errands and running them. You can always do both.
        </p>
        <ModeSwitch />
      </div>
      <ProfileForm user={user} />
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Link className="btn btn--outline" href="/change-password">
          Change password
        </Link>
        <Button variant="subtle" onClick={() => void handleLogout()}>
          Log out
        </Button>
      </div>
    </div>
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
