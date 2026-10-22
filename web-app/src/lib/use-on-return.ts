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
