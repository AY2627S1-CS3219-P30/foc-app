'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Input } from '@/components/Input';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { Select } from '@/components/Select';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { SupplierCard } from '@/components/SupplierCard';
import { bearer, unwrap } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { ADMIN_NAV, STUDENT_NAV } from '@/lib/nav';
import {
  listSupplierDetails,
  supplierApi,
  type Supplier,
  type SupplierInput,
  type SupplierPage,
  type SupplierType,
} from '@/lib/supplier-api';
import { BUILDINGS, SUPPLIER_TYPES, TYPE_LABELS } from '@/lib/supplier-display';
import { SupplierForm } from './SupplierForm';
import styles from './suppliers.module.css';

type Sort = 'name' | 'type' | 'building' | 'updatedAt';
type Listing = { page: SupplierPage; suppliers: Supplier[] };

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

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(query.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const reload = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    let current = true;
    const load = async () => {
      setLoading(true);
      setProblem('');
      try {
        const result = await authed((token) =>
          listSupplierDetails(token, {
            q: search || undefined,
            type: type || undefined,
            building: building || undefined,
            sort,
            order,
            page,
            pageSize: 20,
          }),
        );
        if (current) {
          const lastPage = Math.max(1, Math.ceil(result.page.total / result.page.pageSize));
          if (page > lastPage) setPage(lastPage);
          else setListing(result);
        }
      } catch (cause) {
        if (current)
          setProblem(cause instanceof Error ? cause.message : 'Could not load suppliers.');
      } finally {
        if (current) setLoading(false);
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [authed, search, type, building, sort, order, page, revision]);

  const save = async (body: SupplierInput) => {
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
        : unwrap(supplierApi.POST('/suppliers', { headers: bearer(token), body })),
    );
    setEditing(null);
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
      navItems={admin ? [...ADMIN_NAV, { href: '/suppliers', label: 'Suppliers' }] : STUDENT_NAV}
      activeHref="/suppliers"
      showCreditPill={false}
    >
      <div className={styles.content}>
        {admin && (
          <div className={styles.adminBar}>
            <Button onClick={() => setEditing('new')}>Add supplier</Button>
          </div>
        )}
        {editing && admin && (
          <SupplierForm
            key={editing === 'new' ? 'new' : editing.supplierId}
            supplier={editing === 'new' ? undefined : editing}
            onSave={save}
            onCancel={() => setEditing(null)}
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
              <p role="status" className={styles.count}>
                {listing.page.total} supplier{listing.page.total === 1 ? '' : 's'} found
              </p>
              {listing.suppliers.length ? (
                <div className={styles.cards}>
                  {listing.suppliers.map((supplier) => (
                    <SupplierCard
                      key={`${supplier.supplierId}:${supplier.version}`}
                      supplier={supplier}
                      admin={admin}
                      onEdit={() => setEditing(supplier)}
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
