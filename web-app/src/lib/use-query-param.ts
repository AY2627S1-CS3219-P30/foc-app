"use client";

import { useSyncExternalStore } from "react";

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
