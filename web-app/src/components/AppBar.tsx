"use client";

import { useStore } from "@/lib/store";
import styles from "./AppBar.module.css";
import { LiveLabel } from "./LiveLabel";

export function AppBar({
  title,
  heading = false,
  onBack,
  onPlusClick,
}: {
  title: string;
  /** The title is the page's heading, on a screen with no other (ResponsiveShell has its own). */
  heading?: boolean;
  onBack?: () => void;
  onPlusClick?: () => void;
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
        {heading ? <h1 className={styles.title}>{title}</h1> : <span className={styles.title}>{title}</span>}
        <LiveLabel onBar />
      </span>
      {onPlusClick ? (
        <button className={styles.iconBtn} aria-label="New request" onClick={onPlusClick}>
          +
        </button>
      ) : (
        <span className={styles.spacer} />
      )}
    </header>
  );
}
