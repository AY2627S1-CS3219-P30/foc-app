'use client';

import { useEffect, useState } from 'react';
import { bearer, unwrap } from './api-client';
import { useAuth } from './auth';
import { supplierApi } from './supplier-api';

export type Buildings = { status: 'loading' | 'ready' | 'error'; items: string[] };

/**
 * The Supplier Service's campus buildings or, with `inUse`, only those with an active supplier.
 * `items` is empty until they load, and stays empty if they can't be. A new `revision` reads them
 * again, as after a save or a delete changes which buildings are in use.
 */
export function useBuildings(inUse: boolean, revision = 0): Buildings {
  const { authed } = useAuth();
  const [buildings, setBuildings] = useState<Buildings>({ status: 'loading', items: [] });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        const { items } = await authed((token) =>
          unwrap(
            supplierApi.GET('/buildings', {
              params: { query: { inUse: inUse || undefined } },
              headers: bearer(token),
              signal,
            }),
          ),
        );
        if (!signal.aborted) setBuildings({ status: 'ready', items });
      } catch {
        if (!signal.aborted) setBuildings({ status: 'error', items: [] });
      }
    })();
    return () => controller.abort();
  }, [authed, inUse, revision]);

  return buildings;
}
