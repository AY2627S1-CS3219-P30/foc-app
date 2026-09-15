import Link from "next/link";
import styles from "./Sidebar.module.css";

export type NavItem = { href: string; label: string };

export function Sidebar({ items, activeHref }: { items: NavItem[]; activeHref: string }) {
  return (
    <nav className={styles.sidebar}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`${styles.item} ${item.href === activeHref ? styles.active : ""}`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
