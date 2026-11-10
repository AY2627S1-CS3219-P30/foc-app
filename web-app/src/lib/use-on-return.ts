// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-10-21
// Scope: Generated the initial implementation for "take errands from post to paid in the app"
//   (WEB-02, WEB-05).
// Author review: Patrick Thomas validated correctness and the implementation, and checked for fatal
//   errors and architectural conflicts, before committing.

"use client";

import { useEffect, useEffectEvent } from "react";

/** Calls `onReturn` when the tab becomes visible again or the connection comes back. */
export function useOnReturn(onReturn: () => void) {
  const fire = useEffectEvent(onReturn);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") fire();
    };
    const online = () => fire();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", online);
    };
  }, []);
}
