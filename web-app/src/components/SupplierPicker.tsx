// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-20 to 2026-11-04
// Scope: Generated the initial implementation for "supplier picker and deletion hold" (SUP-04,
//   WEB-08, #375); later bug fixes and new features.
// Author review: Patrick Thomas and Jonus Ho reviewed the implementation for correctness, ran it
//   against the test suite, and checked that it fits our service boundaries without fatal errors
//   before committing.

'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Field } from './Field';
import { Input } from './Input';
import { EmptyState, ErrorState, LoadingState } from './States';
import { bearer, unwrap } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { supplierApi, type SupplierSummary } from '@/lib/supplier-api';
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

const PAGE_SIZE = 100;

type Results = { items: SupplierSummary[]; total: number };

/** Adds a page to the results, skipping any supplier an earlier page already showed. */
const append = (results: Results, next: Results): Results => {
  const shown = new Set(results.items.map((item) => item.supplierId));
  return {
    items: [...results.items, ...next.items.filter((item) => !shown.has(item.supplierId))],
    total: next.total,
  };
};

/** Searches active suppliers only, so a deactivated one is never offered. Pages with Load more. */
export function SupplierPicker({ onSelect }: { onSelect: (supplier: SupplierSummary) => void }) {
  const { authed } = useAuth();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(query.trim());
    }, 300);
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
              params: { query: { q: search || undefined, page, pageSize: PAGE_SIZE } },
              headers: bearer(token),
              signal,
            }),
          ),
        );
        if (!signal.aborted)
          setResults((current) => (page > 1 && current ? append(current, result) : result));
      } catch (cause) {
        if (!signal.aborted)
          setProblem(cause instanceof Error ? cause.message : 'Could not load pickup points.');
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [authed, search, page, revision]);

  const clearSearch = () => {
    setQuery('');
    setSearch('');
    setPage(1);
    // The button that has focus is about to go, so focus returns to where a new search starts.
    searchInput.current?.focus();
  };

  return (
    <div className={styles.picker}>
      <Field label="Search pickup points">
        <Input
          type="search"
          maxLength={200}
          placeholder="Name or building"
          ref={searchInput}
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
      ) : !results ? (
        <LoadingState label="Loading pickup points…" />
      ) : (
        <div className={styles.body} aria-busy={loading || undefined}>
          {results.items.length ? (
            <>
              {results.total > results.items.length && (
                <p className={styles.count}>
                  Showing {results.items.length} of {results.total}. Search to narrow them down.
                </p>
              )}
              <ul className={styles.results}>
                {results.items.map((supplier) => (
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
              {results.total > results.items.length && (
                <Button
                  variant="outline"
                  disabled={loading}
                  onClick={() => setPage((current) => current + 1)}
                >
                  {loading ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </>
          ) : (
            <EmptyState
              title="No pickup points found"
              action={
                (query.trim() !== '' || search !== '') && (
                  <Button variant="outline" onClick={clearSearch}>
                    Clear search
                  </Button>
                )
              }
            >
              Try another name or building.
            </EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
