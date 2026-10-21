"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { getMyWallet } from "@/lib/order-api";
import { useOnReturn } from "@/lib/use-on-return";
import { ModeSwitch } from "./ModeSwitch";
import styles from "./TopBar.module.css";

const CREDITS_POLL_MS = 30_000;

/**
 * The available balance, or `null` while it is unknown: the pill is advice, so a failure just hides it.
 * Credits move on the server (reservations, releases, payouts), so it is read again on a timer and on return.
 */
function useAvailableCredits(enabled: boolean) {
  const { authed } = useAuth();
  const [available, setAvailable] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  useOnReturn(() => setRevision((r) => r + 1));

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function read() {
      if (document.visibilityState === "hidden") return;
      try {
        const wallet = await authed(getMyWallet);
        if (live) setAvailable(wallet.available);
      } catch {
        if (live) setAvailable(null);
      }
      if (live) timer = setTimeout(read, CREDITS_POLL_MS);
    }

    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [authed, enabled, revision]);
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
