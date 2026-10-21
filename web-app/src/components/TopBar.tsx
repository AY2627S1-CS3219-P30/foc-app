"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { getMyWallet } from "@/lib/order-api";
import { ModeSwitch } from "./ModeSwitch";
import styles from "./TopBar.module.css";

/** The available balance, or `null` while it is unknown: the pill is advice, so a failure just hides it. */
function useAvailableCredits(enabled: boolean) {
  const { authed } = useAuth();
  const [available, setAvailable] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    authed(getMyWallet).then(
      (wallet) => live && setAvailable(wallet.available),
      () => live && setAvailable(null),
    );
    return () => {
      live = false;
    };
  }, [authed, enabled]);
  return available;
}

export function TopBar({
  logoText = "NUQueSt",
  showCreditPill = true,
}: {
  logoText?: string;
  showCreditPill?: boolean;
}) {
  const { user } = useAuth();
  const available = useAvailableCredits(showCreditPill);
  const name = user?.profile.displayName ?? "";
  return (
    <div className={styles.bar}>
      <span className={styles.logo}>{logoText}</span>
      <div className={styles.right}>
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
