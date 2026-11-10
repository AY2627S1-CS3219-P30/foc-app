// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-09-30
// Scope: Generated the initial implementation (WEB-00).
// Author review: Patrick Thomas validated the behaviour and the implementation, checked for fatal
//   errors, and confirmed it does not conflict with the architecture before committing.

import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Button } from "./Button";
import styles from "./States.module.css";

/** A placeholder block. Size it with `className`; the default is one card-sized row. */
export function Skeleton({ className }: { className?: string }) {
  return <span className={cx(styles.skeleton, className)} aria-hidden="true" />;
}

/** Keep mounted across in-page loading updates so assistive technology can announce label changes. */
export function LoadingState({ label = "Loading…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" className={styles.loading}>
      <span>{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={styles.state}>
      <p className={styles.title}>{title}</p>
      {children && <div className={styles.body}>{children}</div>}
      {action}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  children,
  onRetry,
  retryLabel = "Try again",
}: {
  title?: string;
  children?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div role="alert" className={styles.state}>
      <p className={styles.title}>{title}</p>
      {children && <div className={styles.body}>{children}</div>}
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
