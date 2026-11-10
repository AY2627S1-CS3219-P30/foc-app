// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-11-08
// Scope: Generated the initial implementation for "share feed/history polling and the review step's
//   wallet read".
// Author review: Patrick Thomas reviewed the implementation for correctness, ran it against the
//   test suite, and checked that it fits our service boundaries without fatal errors before
//   committing.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api-client";
import { appendPage, refreshPage, type PagedOrders } from "./paged-orders";
import { usePoll } from "./use-poll";

const RETRY_MS = 30_000;

type Page<T> = { items: T[]; nextCursor: string | null };
type Scoped<V> = { key: string } & V;

const message = (err: unknown) => (err instanceof ApiError ? err.message : "Something went wrong.");

const mapLists = <N extends string, A, B>(lists: Record<N, A>, map: (value: A, list: N) => B) =>
  Object.fromEntries(
    Object.entries<A>(lists).map(([list, value]) => [list, map(value, list as N)]),
  ) as Record<N, B>;

/**
 * Lists of orders read by `usePoll` on the schedule `read` returns, each loading older pages through
 * `readMore`. Everything belongs to `key`: a new key hides the last lists and cancels a page still
 * loading. A failed read keeps the last lists, and `read` resolving to `null` reads nothing.
 */
export function usePagedPoll<N extends string, T extends { orderId: string }>(
  key: string,
  read: (signal: AbortSignal) => Promise<{ lists: Record<N, Page<T>>; delay: number | null } | null>,
  readMore: (cursor: string, signal: AbortSignal, list: N) => Promise<Page<T>>,
) {
  const [result, setResult] = useState<Scoped<{ lists: Record<N, PagedOrders<T>> }> | null>(null);
  const [failure, setFailure] = useState<Scoped<{ message: string }> | null>(null);
  const [moreFailure, setMoreFailure] = useState<Scoped<{ list: N; message: string }> | null>(null);
  const [loading, setLoading] = useState<Scoped<{ list: N }> | null>(null);

  const poll = useCallback(
    async (signal: AbortSignal) => {
      try {
        const next = await read(signal);
        if (!next || signal.aborted) return null;
        setResult((current) => {
          const last = current?.key === key ? current.lists : null;
          return { key, lists: mapLists(next.lists, (page, list) => refreshPage(last?.[list] ?? null, page)) };
        });
        setFailure(null);
        return next.delay;
      } catch (err) {
        if (signal.aborted) return null;
        setFailure({ key, message: message(err) });
        return RETRY_MS;
      }
    },
    [key, read],
  );
  const reload = usePoll(poll);

  const moreRequest = useRef<AbortController | null>(null);
  useEffect(() => () => moreRequest.current?.abort(), [key]);
  const loadMore = useCallback(
    async (list: N) => {
      const cursor = result?.key === key ? result.lists[list].nextCursor : null;
      if (!cursor || loading?.key === key) return;
      const controller = new AbortController();
      moreRequest.current = controller;
      const { signal } = controller;
      setLoading({ key, list });
      setMoreFailure(null);
      try {
        const page = await readMore(cursor, signal, list);
        if (signal.aborted) return;
        setResult((current) =>
          current?.key === key && current.lists[list].nextCursor === cursor
            ? { key, lists: { ...current.lists, [list]: appendPage(current.lists[list], page) } }
            : current,
        );
      } catch (err) {
        if (!signal.aborted) setMoreFailure({ key, list, message: message(err) });
      } finally {
        setLoading((current) => (current?.key === key ? null : current));
      }
    },
    [key, loading, readMore, result],
  );

  const remove = useCallback(
    (orderId: string) =>
      setResult((current) =>
        current?.key === key
          ? {
              key,
              lists: mapLists(current.lists, (page) => ({
                ...page,
                items: page.items.filter((item) => item.orderId !== orderId),
              })),
            }
          : current,
      ),
    [key],
  );

  return {
    result: result?.key === key ? result.lists : null,
    problem: failure?.key === key ? failure.message : null,
    reload,
    loadMore,
    moreProblem: moreFailure?.key === key ? moreFailure : null,
    loadingMore: loading?.key === key ? loading.list : null,
    remove,
  };
}

/**
 * The lists to show and the mode they were read for. While another mode's (or filter's) lists are
 * loading, the last loaded screen stays up whole, title and all, so a switch never flashes a
 * skeleton; `stale` says it is being replaced. A failed first read for the new mode shows as such.
 */
export function useKeptWhileLoading<M, R>(mode: M, result: R | null, problem: string | null) {
  const [kept, setKept] = useState<{ mode: M; result: R } | null>(null);
  if (result !== null && (kept?.result !== result || kept.mode !== mode)) setKept({ mode, result });
  if (result !== null || problem !== null || kept === null) return { mode, result, stale: false };
  return { mode: kept.mode, result: kept.result as R | null, stale: true };
}
