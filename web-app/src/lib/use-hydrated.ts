"use client";

import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/**
 * False during server rendering and hydration, true once React runs the page in the browser.
 *
 * Account forms keep their submit button disabled until then. Before hydration no `onSubmit` is
 * attached, so a click (or Enter, whose implicit submission a disabled default button blocks) would
 * be a native submission carrying the password to the server.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}
