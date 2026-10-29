"use client";

import { useStore } from "@/lib/store";
import styles from "./AppBar.module.css";
import { LiveLabel } from "./LiveLabel";

export function AppBar({
  title,
  onBack,
  onPlusClick,
}: {
  title: string;
  onBack?: () => void;
  onPlusClick?: () => void;
}) {
  const { setMenuOpen } = useStore();
  return (
    <div className={styles.bar}>
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
      {onPlusClick ? (
        <button className={styles.iconBtn} aria-label="New request" onClick={onPlusClick}>
          +
        </button>
      ) : (
        <span className={styles.spacer} />
      )}
    </div>
  );
}
