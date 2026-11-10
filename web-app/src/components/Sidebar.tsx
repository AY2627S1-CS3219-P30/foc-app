// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-10-27
// Scope: Implementation for "account screens on the real User Service" (USR-05).
// Author review: Anselm Long validated correctness and the implementation, and checked for fatal
//   errors and architectural conflicts, before committing.

"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { navForMode, withAdminEntry } from "@/lib/nav";
import styles from "./Sidebar.module.css";

export type NavItem = { href: string; label: string };

export function Sidebar({ items, activeHref }: { items: NavItem[]; activeHref: string }) {
  const { user, logout } = useAuth();
  return (
    <nav className={styles.sidebar} aria-label="Main">
      {navForMode(withAdminEntry(items, user?.roles), user?.profile.preferredMode).map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`${styles.item} ${item.href === activeHref ? styles.active : ""}`}
          aria-current={item.href === activeHref ? "page" : undefined}
        >
          {item.label}
        </Link>
      ))}
      {/* The (app) layout takes a signed-out visitor to sign in, as from the drawer's Log out. */}
      <button className={`${styles.item} ${styles.logout}`} onClick={() => void logout()}>
        Log out
      </button>
    </nav>
  );
}
