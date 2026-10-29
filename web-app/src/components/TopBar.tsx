"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useCredits } from "@/lib/credits";
import { LiveLabel } from "./LiveLabel";
import { ModeSwitch } from "./ModeSwitch";
import styles from "./TopBar.module.css";

export function TopBar({
  logoText = "NUQueSt",
  showCreditPill = true,
}: {
  logoText?: string;
  showCreditPill?: boolean;
}) {
  const { user } = useAuth();
  const { available } = useCredits();
  const name = user?.profile.displayName ?? "";
  return (
    <div className={styles.bar}>
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
    </div>
  );
}
