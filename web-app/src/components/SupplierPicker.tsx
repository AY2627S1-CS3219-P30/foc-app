'use client';

import { useEffect, useState } from 'react';
import { Field } from './Field';
import { Input } from './Input';
import { EmptyState, ErrorState, LoadingState } from './States';
import { bearer, unwrap } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { supplierApi, type SupplierPage, type SupplierSummary } from '@/lib/supplier-api';
import { TYPE_LABELS } from '@/lib/supplier-display';
import styles from './SupplierPicker.module.css';

/** Also the composer's answer to a `422 INVALID_SUPPLIER` on submit. */
export const SUPPLIER_UNAVAILABLE = 'This pickup point is no longer available. Choose another.';

export function SupplierUnavailable({ onChooseAnother }: { onChooseAnother: () => void }) {
  return (
    <ErrorState
      title={SUPPLIER_UNAVAILABLE}
      onRetry={onChooseAnother}
      retryLabel="Back to pickup points"
    />
  );
}

/** Searches active suppliers only, so a deactivated one is never offered. */
export function SupplierPicker({ onSelect }: { onSelect: (supplier: SupplierSummary) => void }) {
  const { authed } = useAuth();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<SupplierPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const load = async () => {
      setLoading(true);
      setProblem('');
      try {
        const result = await authed((token) =>
          unwrap(
            supplierApi.GET('/suppliers', {
              params: { query: { q: search || undefined, pageSize: 100 } },
              headers: bearer(token),
              signal,
            }),
          ),
        );
        if (!signal.aborted) setPage(result);
      } catch (cause) {
        if (!signal.aborted)
          setProblem(cause instanceof Error ? cause.message : 'Could not load pickup points.');
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [authed, search, revision]);

  return (
    <div className={styles.picker}>
      <Field label="Search pickup points">
        <Input
          type="search"
          maxLength={200}
          placeholder="Name or building"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </Field>
      {problem ? (
        <ErrorState
          title="Could not load pickup points"
          onRetry={() => setRevision((current) => current + 1)}
        >
          {problem}
        </ErrorState>
      ) : !page ? (
        <LoadingState label="Loading pickup points…" />
      ) : (
        <div className={styles.body} aria-busy={loading || undefined}>
          {page.items.length ? (
            <>
              {page.total > page.items.length && (
                <p className={styles.count}>
                  Showing {page.items.length} of {page.total}. Search to narrow them down.
                </p>
              )}
              <ul className={styles.results}>
                {page.items.map((supplier) => (
                  <li key={supplier.supplierId}>
                    <button
                      type="button"
                      className={`card ${styles.option}`}
                      onClick={() => onSelect(supplier)}
                    >
                      <span className={styles.name}>{supplier.name}</span>
                      <span className={styles.meta}>
                        {TYPE_LABELS[supplier.type]} · {supplier.building}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <EmptyState title="No pickup points found">Try another name or building.</EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
