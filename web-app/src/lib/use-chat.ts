// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-11-08
// Scope: Implementation for "nudge the chat panel over the notify-only socket" (#346).
// Author review: Patrick Thomas verified correctness, tested the change, and checked for fatal
//   errors and conflicts with our architecture before committing.

"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useAuth } from "./auth";
import { CHAT_SERVICE_URL } from "./chat-api";
import { ChatSocket, chatSocketUrl, openWhileVisible } from "./chat-socket";
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
  const [live, setLive] = useState(false);
  const read = useCallback(
    (signal: AbortSignal) => {
      // An order revision rechecks availability even when polling previously stopped at 404/closed.
      // A change in `live` reads at once: the socket's catch-up, or polling resuming after a drop.
      return userId ? store.refresh(signal, final, version, live) : Promise.resolve(null);
    },
    [store, userId, version, final, live],
  );
  const refresh = usePoll(read);
  const nudged = !readOnly && !final && !!userId && !!state.channel?.open && !state.closed;
  useEffect(() => {
    if (!nudged) return;
    const socket = new ChatSocket({
      url: chatSocketUrl(CHAT_SERVICE_URL, window.location.href),
      authed,
      onLive: setLive,
      onMessages: (id, latestSeq) => {
        if (id === orderId && store.behind(latestSeq)) refresh();
      },
    });
    return openWhileVisible(socket);
  }, [nudged, authed, orderId, store, refresh]);
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
