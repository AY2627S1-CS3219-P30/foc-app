// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-09-30
// Scope: Implementation for "account screens on the real User Service" (USR-05, #193); also bug
//   fixes.
// Author review: Anselm Long and Jonus Ho checked the code for correctness against the ticket,
//   confirmed the tests pass, and made sure it caused no fatal errors or architectural conflicts
//   before committing.

"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { navForMode, STUDENT_NAV, withAdminEntry } from "@/lib/nav";
import { useStore } from "@/lib/store";
import { ModeSwitch } from "./ModeSwitch";
import styles from "./Menu.module.css";

export function Menu() {
  const { state, setMenuOpen } = useStore();
  const { logout, user } = useAuth();
  const panelRef = useRef<HTMLElement>(null);

  const isOpen = state.isMenuOpen;

  useEffect(() => {
    if (!isOpen) return;

    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusable = panel?.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled]), input:not([disabled])",
    );
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
        <div className={styles.mode}>
          <ModeSwitch />
        </div>
        {navForMode(withAdminEntry(STUDENT_NAV, user?.roles), user?.profile.preferredMode).map((item) => (
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
            // The (app) layout takes a signed-out visitor to sign in.
            void logout();
          }}
        >
          Log out
        </button>
      </nav>
    </div>
  );
}
