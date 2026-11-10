// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-09-30
// Scope: Generated the initial implementation for "harden account screens and sessions (PR #193
//   review)" (#193).
// Author review: Jonus Ho reviewed the implementation for correctness, ran it against the test
//   suite, and checked that it fits our service boundaries without fatal errors before committing.

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
