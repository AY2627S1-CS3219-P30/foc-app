// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-11-08
// Scope: Implementation for "account screens on the real User Service" (USR-05, WEB-00, WEB-02);
//   also bug fixes, refactoring and tests.
// Author review: Patrick Thomas, Anselm Long and Jonus Ho reviewed the implementation for
//   correctness, ran it against the test suite, and checked that it fits our service boundaries
//   without fatal errors before committing.

"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useCredits } from "@/lib/credits";
import { LiveLabel } from "./LiveLabel";
import { ModeSwitch } from "./ModeSwitch";
import styles from "./TopBar.module.css";

export function TopBar({
  logoText = "Friend on Campus",
  showCreditPill = true,
}: {
  logoText?: string;
  showCreditPill?: boolean;
}) {
  const { user } = useAuth();
  const { available } = useCredits();
  const name = user?.profile.displayName ?? "";
  return (
    <header className={styles.bar}>
      <span className={styles.logo}>{logoText}</span>
      <div className={styles.right}>
        <LiveLabel />
        <ModeSwitch />
        {showCreditPill && available !== null && (
          <span className={styles.creditPill}>{available} credits</span>
        )}
        <Link href="/profile" className={styles.avatar} aria-label={`Profile: ${name}`}>
          <span aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
        </Link>
      </div>
    </header>
  );
}
