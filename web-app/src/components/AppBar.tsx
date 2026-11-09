// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-21 to 2026-11-05
// Scope: Implementation for "live errand updates, one stream per tab and the pages that use it
//   (N1.4, #331)" (SUP-04, #331, #166); also bug fixes and tests.
// Author review: Jonus Ho, Anselm Long and Patrick Thomas checked the code for correctness against
//   the ticket, confirmed the tests pass, and made sure it caused no fatal errors or architectural
//   conflicts before committing.

"use client";

import { useStore } from "@/lib/store";
import styles from "./AppBar.module.css";
import { Icon } from "./Icon";
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
          <Icon name="back" />
        </button>
      ) : (
        <button className={styles.iconBtn} aria-label="Open menu" onClick={() => setMenuOpen(true)}>
          <Icon name="menu" />
        </button>
      )}
      <span className={styles.titleBlock}>
        <span className={styles.title}>{title}</span>
        <LiveLabel onBar />
      </span>
      {action ? (
        <button className={styles.iconBtn} aria-label={action.label} onClick={action.onClick}>
          <Icon name="plus" />
        </button>
      ) : (
        <span className={styles.spacer} />
      )}
    </header>
  );
}
