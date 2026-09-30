import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Button } from "./Button";
import styles from "./States.module.css";

/** A placeholder block. Size it with `className`; the default is one card-sized row. */
export function Skeleton({ className }: { className?: string }) {
  return <span className={cx(styles.skeleton, className)} aria-hidden="true" />;
}

export function LoadingState({ label = "Loading…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" className={styles.loading}>
      <span className="srOnly">{label}</span>
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
