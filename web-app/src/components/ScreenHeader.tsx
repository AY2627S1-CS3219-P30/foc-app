"use client";

import { useRouter } from "next/navigation";
import { LiveLabel } from "./LiveLabel";
import styles from "./ScreenHeader.module.css";

export function ScreenHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  const router = useRouter();
  return (
    <header className={styles.header}>
      <button className={styles.back} aria-label="Back" onClick={onBack ?? (() => router.back())}>
        ←
      </button>
      <h1 className={styles.title}>{title}</h1>
      <span className={styles.live}>
        <LiveLabel />
      </span>
    </header>
  );
}
