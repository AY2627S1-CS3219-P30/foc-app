"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useAuth } from "./auth";
import { createChatState } from "./chat-state";
import { usePoll } from "./use-poll";

export function useChat(
  orderId: string,
  version: number | undefined,
  final: boolean,
  readOnly = false,
) {
  const { user, authed } = useAuth();
  const userId = user?.id ?? "";
  const store = useMemo(
    () => createChatState(orderId, userId, authed, readOnly),
    [orderId, userId, authed, readOnly],
  );
  useEffect(() => store.mount(), [store]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const read = useCallback(
    (signal: AbortSignal) => {
      // An order revision rechecks availability even when polling previously stopped at 404/closed.
      return userId ? store.refresh(signal, final, version) : Promise.resolve(null);
    },
    [store, userId, version, final],
  );
  const refresh = usePoll(read);
  return {
    ...state,
    unread: store.unread(),
    refresh,
    loadOlder: store.older,
    markRead: store.markVisibleRead,
    send: (body: string) => store.send(body, final),
    retry: (clientId: string) => store.retry(clientId, final),
  };
}
