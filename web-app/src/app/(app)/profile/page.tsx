"use client";

import Link from "next/link";
import { Button } from "@/components/Button";
import { ModeSwitch } from "@/components/ModeSwitch";
import { ResponsiveShell } from "@/components/ResponsiveShell";
import { useAuth } from "@/lib/auth";
import { STUDENT_NAV } from "@/lib/nav";
import { ProfileForm } from "./ProfileForm";

/** One tree for every width (ResponsiveShell), because it holds a form: see decisions.md W3. */
export default function ProfilePage() {
  const { user, logout } = useAuth();
  // The (app) layout only renders this once signed in.
  if (!user) return null;

  return (
    <ResponsiveShell title="Profile" navItems={STUDENT_NAV} activeHref="/profile">
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
          {/* The (app) layout takes a signed-out visitor to sign in. */}
          <Button variant="subtle" onClick={() => void logout()}>
            Log out
          </Button>
        </div>
      </div>
    </ResponsiveShell>
  );
}
