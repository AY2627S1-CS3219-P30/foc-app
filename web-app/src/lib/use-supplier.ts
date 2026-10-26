'use client';

import { useEffect, useState } from 'react';
import { ApiError, bearer, unwrap } from './api-client';
import { useAuth } from './auth';
import { supplierApi, type Supplier } from './supplier-api';

export type SupplierLookup =
  | { status: 'loading' }
  | { status: 'ready'; supplier: Supplier }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** The service refuses a malformed id with 422 `VALIDATION_FAILED` on `id`. */
const isUnavailable = (cause: unknown) =>
  cause instanceof ApiError &&
  (cause.status === 404 ||
    (cause.code === 'VALIDATION_FAILED' && cause.fieldMessage('id') !== undefined));

/** A deactivated, missing or malformed supplier is `unavailable`, so it can be explained. */
export function useSupplier(supplierId: string | null): [SupplierLookup, () => void] {
  const { authed } = useAuth();
  const [lookup, setLookup] = useState<SupplierLookup>({ status: 'loading' });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const load = async (): Promise<SupplierLookup> => {
      if (!supplierId) return { status: 'unavailable' };
      try {
        const supplier = await authed((token) =>
          unwrap(
            supplierApi.GET('/suppliers/{supplierId}', {
              params: { path: { supplierId } },
              headers: bearer(token),
              signal,
            }),
          ),
        );
        return supplier.active ? { status: 'ready', supplier } : { status: 'unavailable' };
      } catch (cause) {
        if (isUnavailable(cause)) return { status: 'unavailable' };
        return {
          status: 'error',
          message: cause instanceof Error ? cause.message : 'Could not load the pickup point.',
        };
      }
    };
    void (async () => {
      setLookup({ status: 'loading' });
      const result = await load();
      if (!signal.aborted) setLookup(result);
    })();
    return () => controller.abort();
  }, [authed, supplierId, revision]);

  return [lookup, () => setRevision((current) => current + 1)];
}
