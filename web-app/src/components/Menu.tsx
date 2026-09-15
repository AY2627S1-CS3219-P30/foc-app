"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
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
  const panelRef = useRef<HTMLElement>(null);

  const isOpen = state.isMenuOpen;

  useEffect(() => {
    if (!isOpen) return;

    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusable = panel?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
    focusable?.[0]?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
        return;
      }
      if (e.key !== "Tab" || !focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [isOpen, setMenuOpen]);

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={() => setMenuOpen(false)}>
      <nav
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onClick={(e) => e.stopPropagation()}
      >
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
