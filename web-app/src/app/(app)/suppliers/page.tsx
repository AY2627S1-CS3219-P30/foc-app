'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Input } from '@/components/Input';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { Select } from '@/components/Select';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { SupplierCard, supplierHeadingId } from '@/components/SupplierCard';
import { ApiError, bearer, newCorrelationId, unwrap } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { ADMIN_NAV, STUDENT_NAV } from '@/lib/nav';
import {
  listSupplierDetails,
  supplierApi,
  type Supplier,
  type SupplierInput,
  type SupplierListing,
  type SupplierType,
} from '@/lib/supplier-api';
import { BUILDINGS, SUPPLIER_TYPES, TYPE_LABELS } from '@/lib/supplier-display';
import { SupplierForm } from './SupplierForm';
import styles from './suppliers.module.css';

type Sort = 'name' | 'type' | 'building' | 'updatedAt';
type Listing = SupplierListing;
/** Where focus goes back to when the supplier form closes. */
type FocusReturn = {
  opener: HTMLElement | null;
  supplierId?: string;
  /** Wait out the reload after a save, which replaces the opener's card (its key has the version). */
  afterReload: boolean;
};

/** Brings the inline form into view and tells keyboard and screen-reader users it opened. */
function revealForm(heading: HTMLElement | null) {
  if (!heading) return;
  heading.focus({ preventScroll: true });
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  heading.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
}

export default function SuppliersPage() {
  const { authed, user } = useAuth();
  const admin = user?.roles.includes('ADMIN') ?? false;
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [type, setType] = useState<SupplierType | ''>('');
  const [building, setBuilding] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');
  const [actionProblem, setActionProblem] = useState('');
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const resultsCount = useRef<HTMLParagraphElement>(null);
  const formDirty = useRef(false);
  /**
   * The Idempotency-Key for adding a supplier. One key lasts until a create is known to have
   * happened (the service answered, or said the key was already used), so saving again after an
   * answer that never arrived replays that create rather than making a second supplier, even after
   * the values are edited or the form is cancelled and opened again. The service keeps a key only
   * when its create commits, so a save it refused (a field error) leaves the key for the next one.
   */
  const createKey = useRef<string | null>(null);
  /** Counts each form opened or closed, so a save's late answer closes only the form it came from. */
  const formRun = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const focusReturn = useRef<FocusReturn | null>(null);
  const editingKey = editing === 'new' ? 'new' : (editing?.supplierId ?? null);
  /** The open form's key, for async work that must not close a form opened in the meantime. */
  const openKey = useRef(editingKey);
  const onDirtyChange = useCallback((dirty: boolean) => {
    formDirty.current = dirty;
  }, []);

  // Keyed on the supplier, not the object, so a refresh after a version conflict doesn't jump.
  useEffect(() => {
    openKey.current = editingKey;
    if (editingKey) revealForm(formHeading.current);
  }, [editingKey]);

  useEffect(() => {
    const target = focusReturn.current;
    if (!target || editing) return;
    if (target.afterReload) {
      if (loading) target.afterReload = false;
      return;
    }
    if (target.opener?.isConnected) {
      focusReturn.current = null;
      target.opener.focus();
      return;
    }
    if (loading) return;
    focusReturn.current = null;
    const heading = target.supplierId
      ? document.getElementById(supplierHeadingId(target.supplierId))
      : null;
    (heading ?? resultsCount.current)?.focus();
  }, [editing, loading]);

  const openForm = (target: Supplier | 'new', from: HTMLElement) => {
    const key = target === 'new' ? 'new' : target.supplierId;
    if (key !== editingKey) {
      if (editing && formDirty.current && !window.confirm('Discard your changes?')) return;
      formDirty.current = false;
      formRun.current += 1;
      setEditing(target);
    } else revealForm(formHeading.current);
    opener.current = from;
    focusReturn.current = null;
  };

  const closeForm = (afterReload: boolean) => {
    focusReturn.current = {
      opener: opener.current,
      supplierId: editing && editing !== 'new' ? editing.supplierId : undefined,
      afterReload,
    };
    opener.current = null;
    formDirty.current = false;
    formRun.current += 1;
    setEditing(null);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(query.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const reload = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    // Aborting cancels the superseded requests; their AbortError is ignored like any stale result.
    const controller = new AbortController();
    const { signal } = controller;
    const load = async () => {
      setLoading(true);
      setProblem('');
      try {
        const result = await authed((token) =>
          listSupplierDetails(
            token,
            {
              q: search || undefined,
              type: type || undefined,
              building: building || undefined,
              sort,
              order,
              page,
              pageSize: 20,
            },
            signal,
          ),
        );
        if (!signal.aborted) {
          const lastPage = Math.max(1, Math.ceil(result.page.total / result.page.pageSize));
          if (page > lastPage) setPage(lastPage);
          else setListing(result);
        }
      } catch (cause) {
        if (!signal.aborted)
          setProblem(cause instanceof Error ? cause.message : 'Could not load suppliers.');
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [authed, search, type, building, sort, order, page, revision]);

  const save = async (body: SupplierInput) => {
    const run = formRun.current;
    const adding = editing === 'new';
    try {
      await authed((token) =>
        editing && editing !== 'new'
          ? unwrap(
              supplierApi.PUT('/suppliers/{supplierId}', {
                params: {
                  path: { supplierId: editing.supplierId },
                  header: { 'If-Match': String(editing.version) },
                },
                headers: bearer(token),
                body,
              }),
            )
          : unwrap(
              supplierApi.POST('/suppliers', {
                params: {
                  header: { 'Idempotency-Key': (createKey.current ??= newCorrelationId()) },
                },
                headers: bearer(token),
                body,
              }),
            ),
      );
    } catch (cause) {
      if (adding && cause instanceof ApiError && cause.code === 'IDEMPOTENCY_KEY_REUSED') {
        // An earlier save committed though its answer was lost, and these values differ from it.
        // Show it in the list; saving again now adds a second supplier, under a new key.
        createKey.current = null;
        reload();
        throw new ApiError(
          cause.status,
          cause.code,
          'Your earlier save went through, though its answer never arrived, so that supplier is already in the list with the values you saved then. Edit it there, or save again to add another supplier.',
        );
      }
      if (!(cause instanceof ApiError && cause.status === 412 && editing && editing !== 'new'))
        throw cause;
      // Someone else saved first. Swap in the current version without remounting the form (it is
      // keyed by supplierId), so the admin's typed values stay and the next save sends the new version.
      reload();
      const { code } = cause;
      const supplierId = editing.supplierId;
      const fresh = await authed((token) =>
        unwrap(
          supplierApi.GET('/suppliers/{supplierId}', {
            params: { path: { supplierId } },
            headers: bearer(token),
          }),
        ),
      ).catch((refetch: unknown) => {
        if (refetch instanceof ApiError && refetch.status === 404) return null;
        throw new ApiError(
          412,
          code,
          'This supplier was changed by someone else and its latest version could not be loaded. Try saving again.',
        );
      });
      if (!fresh) {
        // The reload above may already be done; focus waits for one that starts after the close,
        // and lands on the results count since the supplier's card is gone.
        if (openKey.current === supplierId) {
          closeForm(true);
          reload();
        }
        setActionProblem('This supplier was deleted.');
        return;
      }
      setEditing((current) =>
        current !== null && current !== 'new' && current.supplierId === supplierId ? fresh : current,
      );
      throw new ApiError(
        412,
        code,
        'This supplier was changed by someone else. Your edits are kept; review and save again to overwrite.',
      );
    }
    if (adding) createKey.current = null;
    // A new supplier's opener (Add supplier) survives the reload, so focus can go back at once. A
    // late answer leaves alone a form opened since this save began.
    if (formRun.current === run) closeForm(!adding);
    reload();
  };

  const remove = async (supplier: Supplier) => {
    if (!window.confirm(`Delete ${supplier.name}? It will disappear from the supplier list.`))
      return;
    setActionProblem('');
    try {
      await authed((token) =>
        unwrap(
          supplierApi.DELETE('/suppliers/{supplierId}', {
            params: {
              path: { supplierId: supplier.supplierId },
              header: { 'If-Match': String(supplier.version) },
            },
            headers: bearer(token),
          }),
        ),
      );
      reload();
    } catch (cause) {
      setActionProblem(cause instanceof Error ? cause.message : 'Could not delete the supplier.');
      // The card may be out of date (a 412 means someone else changed it); show the current state.
      if (cause instanceof ApiError) reload();
    }
  };

  const pageCount = listing
    ? Math.max(1, Math.ceil(listing.page.total / listing.page.pageSize))
    : 1;
  const changeFilter = (change: () => void) => {
    change();
    setPage(1);
  };

  return (
    <ResponsiveShell
      title="Campus suppliers"
      navItems={admin ? ADMIN_NAV : STUDENT_NAV}
      logoText={admin ? 'NUQueSt Admin' : undefined}
      activeHref="/suppliers"
      showCreditPill={false}
    >
      <div className={styles.content}>
        {admin && (
          <div className={styles.adminBar}>
            <Button onClick={(event) => openForm('new', event.currentTarget)}>Add supplier</Button>
          </div>
        )}
        {editing && admin && (
          <SupplierForm
            key={editing === 'new' ? 'new' : editing.supplierId}
            supplier={editing === 'new' ? undefined : editing}
            onSave={save}
            onCancel={() => closeForm(false)}
            onDirtyChange={onDirtyChange}
            headingRef={formHeading}
          />
        )}
        <div className={styles.filters}>
          <Field label="Search suppliers">
            <Input
              type="search"
              maxLength={200}
              placeholder="Name or location"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <Button
            variant="outline"
            className={styles.filterToggle}
            aria-expanded={filtersOpen}
            aria-controls="supplier-filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            Filters and sort
          </Button>
          <div id="supplier-filters" className={styles.filterGrid} data-open={filtersOpen}>
            <Field label="Type">
              <Select
                value={type}
                onChange={(event) =>
                  changeFilter(() => setType(event.target.value as SupplierType | ''))
                }
              >
                <option value="">All types</option>
                {SUPPLIER_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {TYPE_LABELS[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Building">
              <Select
                value={building}
                onChange={(event) => changeFilter(() => setBuilding(event.target.value))}
              >
                <option value="">All buildings</option>
                {BUILDINGS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sort by">
              <Select
                value={sort}
                onChange={(event) => changeFilter(() => setSort(event.target.value as Sort))}
              >
                <option value="name">Name</option>
                <option value="type">Type</option>
                <option value="building">Building</option>
                <option value="updatedAt">Updated</option>
              </Select>
            </Field>
            <Field label="Sort order">
              <Select
                value={order}
                onChange={(event) =>
                  changeFilter(() => setOrder(event.target.value as 'asc' | 'desc'))
                }
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </Select>
            </Field>
          </div>
        </div>
        {actionProblem && (
          <div role="alert" className={styles.actionError}>
            <span>{actionProblem}</span>
            <Button variant="outline" onClick={() => setActionProblem('')}>
              Dismiss
            </Button>
          </div>
        )}
        {loading ? (
          <LoadingState label="Loading suppliers…" />
        ) : problem ? (
          <ErrorState title="Could not load suppliers" onRetry={reload}>
            {problem}
          </ErrorState>
        ) : (
          listing && (
            <>
              <p role="status" ref={resultsCount} tabIndex={-1} className={styles.count}>
                {listing.page.total} supplier{listing.page.total === 1 ? '' : 's'} found
                {listing.failed > 0 && ` (${listing.failed} couldn't be loaded)`}
              </p>
              {listing.suppliers.length ? (
                <div className={styles.cards}>
                  {listing.suppliers.map((supplier) => (
                    <SupplierCard
                      key={`${supplier.supplierId}:${supplier.version}`}
                      supplier={supplier}
                      admin={admin}
                      onEdit={(button) => openForm(supplier, button)}
                      onDelete={() => void remove(supplier)}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState title="No suppliers found">
                  Try another search, type or building.
                </EmptyState>
              )}
              {pageCount > 1 && (
                <nav aria-label="Supplier pages" className={styles.pagination}>
                  <Button
                    variant="outline"
                    disabled={page <= 1}
                    onClick={() => setPage((value) => value - 1)}
                  >
                    Previous
                  </Button>
                  <span>
                    Page {listing.page.page} of {pageCount}
                  </span>
                  <Button
                    variant="outline"
                    disabled={page >= pageCount}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Next
                  </Button>
                </nav>
              )}
            </>
          )
        )}
      </div>
    </ResponsiveShell>
  );
}
