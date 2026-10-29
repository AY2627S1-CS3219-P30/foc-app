"use client";

import { useRouter } from "next/navigation";
import { LiveLabel } from "./LiveLabel";
import styles from "./ScreenHeader.module.css";

export function ScreenHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  const router = useRouter();
  return (
    <div className={styles.header}>
      <button className={styles.back} aria-label="Back" onClick={onBack ?? (() => router.back())}>
        ←
      </button>
      <span className={styles.title}>{title}</span>
      <span className={styles.live}>
        <LiveLabel />
      </span>
    </div>
  );
}
