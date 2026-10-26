"use client";

import { useCallback, useEffect, useState } from "react";
import { useOnReturn } from "./use-on-return";

/**
 * Calls `read` now, then again after each delay it resolves to, until it resolves to `null`. Reads
 * pause while the tab is hidden; coming back to it or back online, or calling the returned function,
 * reads again at once. `signal` aborts once a newer read starts, so a late answer can be dropped.
 */
export function usePoll(read: (signal: AbortSignal) => Promise<number | null>): () => void {
  const [revision, setRevision] = useState(0);
  const readNow = useCallback(() => setRevision((r) => r + 1), []);
  useOnReturn(readNow);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      if (document.visibilityState === "hidden") return;
      const delay = await read(controller.signal);
      if (delay !== null && !controller.signal.aborted) timer = setTimeout(tick, delay);
    }

    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [read, revision]);

  return readNow;
}
