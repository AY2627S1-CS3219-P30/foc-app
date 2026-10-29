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
