"use client";

import Link from "next/link";
import { Button, buttonClass } from "@/components/Button";
import { ModeSwitch } from "@/components/ModeSwitch";
import { ResponsiveShell } from "@/components/ResponsiveShell";
import { useAuth } from "@/lib/auth";
import { STUDENT_NAV } from "@/lib/nav";
import { vars } from "@/styles/tokens";
import { ProfileForm } from "./ProfileForm";

/** One tree for every width (ResponsiveShell), because it holds a form: see decisions.md W3. */
export default function ProfilePage() {
  const { user, logout } = useAuth();
  // The (app) layout only renders this once signed in.
  if (!user) return null;

  return (
    <ResponsiveShell title="Profile" navItems={STUDENT_NAV} activeHref="/profile">
      <div style={{ display: "flex", flexDirection: "column", gap: vars.space[3] }}>
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: vars.space[2] }}>
          <h2 style={{ fontSize: vars.text.lg, fontWeight: vars.weight.bold }}>Mode</h2>
          <p style={{ fontSize: vars.text.sm, color: vars.color.textSubtle }}>
            Switch between asking for errands and running them. You can always do both.
          </p>
          <ModeSwitch />
        </div>
        <ProfileForm user={user} />
        <div style={{ display: "flex", gap: vars.space[3], flexWrap: "wrap" }}>
          <Link className={buttonClass({ variant: "outline" })} href="/change-password">
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
