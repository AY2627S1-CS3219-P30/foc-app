"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store";
import styles from "./Menu.module.css";

const ITEMS = [
  { href: "/feed", label: "Request feed" },
  { href: "/order-history", label: "Track your requests" },
  { href: "/wallet", label: "Wallet" },
  { href: "/suppliers", label: "Suppliers" },
  { href: "/profile", label: "Profile" },
];

export function Menu() {
  const { state, setMenuOpen, logout } = useStore();
  const router = useRouter();

  if (!state.isMenuOpen) return null;

  return (
    <div className={styles.overlay} onClick={() => setMenuOpen(false)}>
      <nav className={styles.panel} onClick={(e) => e.stopPropagation()}>
        {ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={styles.item}
            onClick={() => setMenuOpen(false)}
          >
            {item.label}
          </Link>
        ))}
        <button
          className={`${styles.item} ${styles.logout}`}
          onClick={() => {
            setMenuOpen(false);
            logout();
            router.push("/login");
          }}
        >
          Log out
        </button>
      </nav>
    </div>
  );
}
