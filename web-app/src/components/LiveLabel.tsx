// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-10-29
// Scope: Generated the initial implementation for "live errand updates, one stream per tab and the
//   pages that use it (N1.4, #331)" (#331).
// Author review: Jonus Ho validated the behaviour and the implementation, checked for fatal errors,
//   and confirmed it does not conflict with the architecture before committing.

"use client";

import type { LiveStatus } from "@/lib/live/connection";
import { useLiveStatus } from "@/lib/live/live";
import styles from "./LiveLabel.module.css";

/** N1.4: whether this page hears of changes at once, or reads them on its timers. */
const LABELS: Record<Exclude<LiveStatus, "connecting">, string> = {
  live: "Live",
  reconnecting: "Reconnecting…",
  polling: "Updating every 30 s",
};

/**
 * Says whether the page has its live-update stream, in words rather than only the dot's colour, as a
 * polite status, so a change is announced. Nothing before the stream first answers, and nothing
 * where there is none at all. `onBar` is for the phone's app bar, on the primary colour.
 */
export function LiveLabel({ onBar = false }: { onBar?: boolean }) {
  const status = useLiveStatus();
  if (!status || status === "connecting") return null;
  return (
    <span className={onBar ? styles.onBar : styles.pill} role="status" data-live={status}>
      <span className={styles.dot} aria-hidden="true" />
      {LABELS[status]}
    </span>
  );
}
