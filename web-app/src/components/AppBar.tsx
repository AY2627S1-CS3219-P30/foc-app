"use client";

import { useStore } from "@/lib/store";
import styles from "./AppBar.module.css";
import { LiveLabel } from "./LiveLabel";

export function AppBar({
  title,
  onBack,
  action,
}: {
  title: string;
  onBack?: () => void;
  /** The screen's main action, as a `+`. */
  action?: { label: string; onClick: () => void };
}) {
  const { setMenuOpen } = useStore();
  return (
    <header className={styles.bar}>
      {onBack ? (
        <button className={styles.iconBtn} aria-label="Back" onClick={onBack}>
          ←
        </button>
      ) : (
        <button className={styles.iconBtn} aria-label="Open menu" onClick={() => setMenuOpen(true)}>
          ☰
        </button>
      )}
      <span className={styles.titleBlock}>
        <span className={styles.title}>{title}</span>
        <LiveLabel onBar />
      </span>
      {action ? (
        <button className={styles.iconBtn} aria-label={action.label} onClick={action.onClick}>
          +
        </button>
      ) : (
        <span className={styles.spacer} />
      )}
    </header>
  );
}
