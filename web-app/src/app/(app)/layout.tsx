"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Menu } from "@/components/Menu";
import { useAuth } from "@/lib/auth";
import styles from "./layout.module.css";

/**
 * Every screen in this group needs a session. While the cold-load refresh is in flight a status is
 * shown (never a blank flash); a signed-out visitor, or one whose session just ended, goes to sign in
 * and comes back here afterwards.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "signedOut") router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, pathname, router]);

  if (status !== "signedIn") {
    return (
      <div className={styles.pending} role="status" aria-live="polite">
        {status === "loading" ? "Loading your account…" : "Redirecting to sign in…"}
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
