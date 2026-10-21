"use client";

import { useEffect, useState } from "react";

/** `setTimeout` fires at once for longer delays, so a far deadline is waited for in steps. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** The current time, read again once `at` passes, so a screen changes exactly at a deadline. */
export function useNowAfter(at: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null || at <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(at - Date.now(), MAX_DELAY_MS));
    return () => clearTimeout(timer);
  }, [at, now]);
  return now;
}

/** The current time, read again every `ms`. */
export function useClock(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
