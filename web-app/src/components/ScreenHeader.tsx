// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-29 to 2026-11-05
// Scope: Implementation for "live errand updates, one stream per tab and the pages that use it
//   (N1.4, #331)" (#331, #166, #367); also tests and bug fixes.
// Author review: Jonus Ho, Anselm Long and Patrick Thomas validated the behaviour and the
//   implementation, checked for fatal errors, and confirmed it does not conflict with the
//   architecture before committing.

"use client";

import { useRouter } from "next/navigation";
import { Icon } from "./Icon";
import { LiveLabel } from "./LiveLabel";
import styles from "./ScreenHeader.module.css";

export function ScreenHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  const router = useRouter();
  return (
    <header className={styles.header}>
      <button className={styles.back} aria-label="Back" onClick={onBack ?? (() => router.back())}>
        <Icon name="back" />
      </button>
      <h1 className={styles.title}>{title}</h1>
      <span className={styles.live}>
        <LiveLabel />
      </span>
    </header>
  );
}
