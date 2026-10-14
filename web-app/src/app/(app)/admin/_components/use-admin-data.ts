"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api-client";

export type AdminData<T> = {
  /** True while a request is in flight; `data` still holds the last answer, if any. */
  loading: boolean;
  data: T | undefined;
  error: ApiError | undefined;
  reload: () => void;
};

const asApiError = (err: unknown) =>
  err instanceof ApiError ? err : new ApiError(0, "ERROR", "Something went wrong. Please try again.");

/**
 * Loads `fetch` with the admin's access token whenever `key` changes, and again on `reload()`. The
 * key must name every input the fetch uses. An answer that arrives after a newer request started is
 * dropped, so a slow page never overwrites a fast one.
 */
export function useAdminData<T>(key: string, fetch: (token: string) => Promise<T>): AdminData<T> {
  const { authed } = useAuth();
  const [version, setVersion] = useState(0);
  const [settled, setSettled] = useState<{ request: string; data?: T; error?: ApiError } | null>(
    null,
  );
  const latest = useRef(fetch);
  useEffect(() => {
    latest.current = fetch;
  });

  const request = `${version}|${key}`;
  useEffect(() => {
    let live = true;
    authed((token) => latest.current(token)).then(
      (data) => live && setSettled({ request, data }),
      (err: unknown) => live && setSettled({ request, error: asApiError(err) }),
    );
    return () => {
      live = false;
    };
  }, [request, authed]);

  const loading = settled?.request !== request;
  return {
    loading,
    data: settled?.data,
    error: loading ? undefined : settled?.error,
    reload: useCallback(() => setVersion((v) => v + 1), []),
  };
}

/** A figure from one load: `undefined` while loading, `null` when its service did not answer. */
export function figure<T>(state: AdminData<T>, pick: (data: T) => number): number | null | undefined {
  if (state.error) return null;
  return state.data === undefined ? undefined : pick(state.data);
}
