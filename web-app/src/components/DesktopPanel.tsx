"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import styles from "./DesktopPanel.module.css";
import { LiveLabel } from "./LiveLabel";

export function DesktopPanel({
  title,
  onBack,
  width = 560,
  children,
}: {
  title: string;
  onBack?: () => void;
  width?: number;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <div className={styles.page}>
      <div className={styles.panel} style={{ maxWidth: width }}>
        <header className={styles.header}>
          <button className={styles.back} aria-label="Back" onClick={onBack ?? (() => router.back())}>
            ←
          </button>
          <h1 className={styles.title}>{title}</h1>
          <span className={styles.live}>
            <LiveLabel />
          </span>
        </header>
        <main className={styles.body}>{children}</main>
      </div>
    </div>
  );
}
