"use client";

import { useRouter } from "next/navigation";
import { LiveLabel } from "./LiveLabel";
import styles from "./ScreenHeader.module.css";

export function ScreenHeader({ title, onBack, className }: { title: string; onBack?: () => void; className?: string }) {
  const router = useRouter();
  return (
    <div className={[styles.header, className].filter(Boolean).join(" ")}>
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
