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
