// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-09-30
// Scope: Generated the initial implementation for "account screens on the real User Service"
//   (USR-05).
// Author review: Anselm Long checked the code for correctness against the ticket, confirmed the
//   tests pass, and made sure it caused no fatal errors or architectural conflicts before
//   committing.

"use client";

import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/**
 * Reads one query parameter on the client. Deliberately not `useSearchParams`, which would force a
 * Suspense boundary on every account page for a value only the client needs. `undefined` during
 * server rendering and hydration, then `string | null`.
 */
export function useQueryParam(name: string): string | null | undefined {
  return useSyncExternalStore(
    noSubscribe,
    () => new URLSearchParams(window.location.search).get(name),
    () => undefined,
  );
}

/**
 * A one-off `?name=1` another page left for this one: `onFound` runs once, and the flag is taken out
 * of the URL so Back or reload don't raise it again.
 */
export function useUrlFlag(name: string, onFound: () => void) {
  const found = useQueryParam(name) === "1";
  const take = useEffectEvent(onFound);
  useEffect(() => {
    if (!found) return;
    take();
    const url = new URL(window.location.href);
    url.searchParams.delete(name);
    window.history.replaceState(null, "", url.href);
  }, [found, name]);
}
