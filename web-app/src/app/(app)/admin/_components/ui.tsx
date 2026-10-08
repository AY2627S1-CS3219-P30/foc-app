"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import { Button } from "@/components/Button";
import { DesktopShell } from "@/components/DesktopShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import type { Tone } from "@/lib/admin-labels";
import { cx } from "@/lib/cx";
import { ADMIN_NAV } from "@/lib/nav";
import { useDirectory } from "./Directory";
import type { AdminData } from "./use-admin-data";
import styles from "./admin.module.css";

export function AdminShell({
  active,
  heading,
  actions,
  children,
}: {
  active: string;
  heading: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DesktopShell
      navItems={ADMIN_NAV}
      activeHref={active}
      logoText="NUQueSt Admin"
      showCreditPill={false}
      heading={heading}
      actions={actions}
    >
      <div className={styles.stack}>{children}</div>
    </DesktopShell>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={cx("card", styles.section)} aria-labelledby={id}>
      <div className={styles.sectionHead}>
        <div>
          <h2 id={id} className={styles.sectionTitle}>
            {title}
          </h2>
          {description && <p className={styles.muted}>{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** The loading, error and empty states of one load, around what it loaded. */
export function Loaded<T>({
  state,
  label,
  isEmpty,
  emptyTitle,
  emptyText,
  children,
}: {
  state: AdminData<T>;
  label: string;
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyText?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (state.error) {
    return (
      <ErrorState title={`Couldn't load ${label}`} onRetry={state.reload}>
        {state.error.message}
      </ErrorState>
    );
  }
  if (state.data === undefined) return <LoadingState label={`Loading ${label}…`} rows={2} />;
  if (isEmpty?.(state.data)) {
    return <EmptyState title={emptyTitle ?? "Nothing here"}>{emptyText}</EmptyState>;
  }
  return <div aria-busy={state.loading || undefined}>{children(state.data)}</div>;
}

/** A short status label. Its words carry the meaning; the colour only repeats it. */
export function Tag({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx(styles.tag, styles[tone])}>{children}</span>;
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className={styles.pager} aria-label="Pages">
      <Button variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span className={styles.muted}>
        Page {page} of {pages}
      </span>
      <Button variant="outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </nav>
  );
}

/** An account by email, linking to its page. Opening that page is recorded as an admin read. */
export function UserLink({ id }: { id: string | null }) {
  const { name } = useDirectory();
  if (!id) return <span className={styles.muted}>System</span>;
  return (
    <Link href={`/admin/users/${id}`} className={styles.link}>
      {name(id)}
    </Link>
  );
}

/** One figure on the overview, linking to where it is explained. */
export function Stat({
  href,
  label,
  value,
}: {
  href: string;
  label: string;
  value: number | undefined | null;
}) {
  return (
    <Link href={href} className={cx("card", styles.stat)}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value === undefined ? "…" : value === null ? "—" : value}</span>
      {value === null && <span className={styles.muted}>Unavailable</span>}
    </Link>
  );
}
