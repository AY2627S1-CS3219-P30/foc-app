"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { orderForMode, withAdminEntry } from "@/lib/nav";
import styles from "./Sidebar.module.css";

export type NavItem = { href: string; label: string };

export function Sidebar({ items, activeHref }: { items: NavItem[]; activeHref: string }) {
  const { user } = useAuth();
  return (
    <nav className={styles.sidebar} aria-label="Main">
      {orderForMode(withAdminEntry(items, user?.roles), user?.profile.preferredMode).map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`${styles.item} ${item.href === activeHref ? styles.active : ""}`}
          aria-current={item.href === activeHref ? "page" : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
