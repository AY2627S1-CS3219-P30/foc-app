"use client";

import { useEffect, useState } from "react";

/** `setTimeout` fires at once for longer delays, so a far deadline is waited for in steps. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * The current time, read again at the moment `next` gives from it, so a screen changes exactly when
 * it should rather than on a fixed tick.
 */
export function useNowAfter(next: (now: number) => number | null): number {
  const [now, setNow] = useState(() => Date.now());
  const at = next(now);
  useEffect(() => {
    if (at === null || at <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(at - Date.now(), MAX_DELAY_MS));
    return () => clearTimeout(timer);
  }, [at, now]);
  return now;
}
