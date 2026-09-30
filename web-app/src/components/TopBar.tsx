"use client";

import Link from "next/link";
import { useStore } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { ModeSwitch } from "./ModeSwitch";
import styles from "./TopBar.module.css";

export function TopBar({
  logoText = "NUQueSt",
  showCreditPill = true,
}: {
  logoText?: string;
  showCreditPill?: boolean;
}) {
  const { state } = useStore();
  const { user } = useAuth();
  const name = user?.profile.displayName ?? "";
  return (
    <div className={styles.bar}>
      <span className={styles.logo}>{logoText}</span>
      <div className={styles.right}>
        <ModeSwitch />
        {showCreditPill && <span className={styles.creditPill}>{state.balance} credits</span>}
        <Link href="/profile" className={styles.avatar} aria-label={`Profile: ${name}`}>
          <span aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
        </Link>
      </div>
    </div>
  );
}
