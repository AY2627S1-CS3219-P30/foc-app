"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Menu } from "@/components/Menu";
import { ErrorState, LoadingState } from "@/components/States";
import { useAuth } from "@/lib/auth";
import styles from "./layout.module.css";

/**
 * Every screen in this group needs a session. While the cold-load refresh is in flight a status is
 * shown (never a blank flash). A signed-out visitor, or one whose session just ended, goes to sign in
 * and comes back here afterwards; someone who signed out on purpose just goes to sign in. This is the
 * only place that navigates on sign-out, so logging out is a single navigation.
 *
 * If the service could not be asked at all (offline, down, misconfigured), that is not a sign-out:
 * the problem is shown with a retry.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { status, endedBy, problem, retry } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status !== "signedOut") return;
    // The query string is part of where they were (`/request/new/details?…`).
    const here = `${pathname}${window.location.search}`;
    router.replace(endedBy === "loggedOut" ? "/login" : `/login?next=${encodeURIComponent(here)}`);
  }, [status, endedBy, pathname, router]);

  if (status === "unavailable") {
    return (
      <div className={styles.pending}>
        <ErrorState title="Can't reach your account" onRetry={() => void retry()}>
          {problem}
        </ErrorState>
      </div>
    );
  }

  if (status !== "signedIn") {
    return (
      <div className={styles.pending}>
        <LoadingState
          label={status === "loading" ? "Loading your account…" : "Redirecting to sign in…"}
        />
      </div>
    );
  }

  return (
    <>
      {children}
      <Menu />
    </>
  );
}
