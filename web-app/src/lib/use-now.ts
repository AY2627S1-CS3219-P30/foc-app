"use client";

import { useEffect, useState } from "react";

/** The current time, read again once `at` passes, so a screen changes exactly at a deadline. */
export function useNowAfter(at: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null || at <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), at - Date.now());
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
