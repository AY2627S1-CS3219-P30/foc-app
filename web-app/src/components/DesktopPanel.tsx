"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import styles from "./DesktopPanel.module.css";

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
        <div className={styles.header}>
          <button className={styles.back} aria-label="Back" onClick={onBack ?? (() => router.back())}>
            ←
          </button>
          <span className={styles.title}>{title}</span>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
