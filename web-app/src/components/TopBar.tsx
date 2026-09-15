"use client";

import Link from "next/link";
import { useStore } from "@/lib/store";
import { CURRENT_USER } from "@/lib/types";
import styles from "./TopBar.module.css";

export function TopBar({
  logoText = "NUQueSt",
  showCreditPill = true,
}: {
  logoText?: string;
  showCreditPill?: boolean;
}) {
  const { state } = useStore();
  return (
    <div className={styles.bar}>
      <span className={styles.logo}>{logoText}</span>
      <div className={styles.right}>
        {showCreditPill && <span className={styles.creditPill}>{state.balance} credits</span>}
        <Link href="/profile" className={styles.avatar} aria-label="Profile">
          {CURRENT_USER.name.charAt(0)}
        </Link>
      </div>
    </div>
  );
}
