import Link from "next/link";
import { formatWhen } from "@/lib/admin-labels";
import { cx } from "@/lib/cx";
import type { LedgerItem } from "@/lib/order-api";
import { vars } from "@/styles/tokens";
import styles from "./LedgerRow.module.css";

const credits = (n: number) => `${n} ${n === 1 ? "credit" : "credits"}`;

function describe({ type, amount, totalChange }: LedgerItem): { label: string; color: string } {
  switch (type) {
    case "ISSUE":
      return { label: "Starting credits", color: vars.color.success };
    case "RESERVE":
      return { label: `${credits(amount)} reserved for your errand`, color: vars.color.warning };
    case "RELEASE":
      return { label: `${credits(amount)} released back to you`, color: vars.color.info };
    case "TRANSFER":
      return totalChange < 0
        ? { label: "Paid your courier", color: vars.color.danger }
        : { label: "Earned for a delivery", color: vars.color.success };
  }
}

export const ledgerAnchor = (transactionId: string) => `tx-${transactionId}`;

/** Where an entry's errand is read: a transfer's receipt, or the errand itself. */
function errandHref({ type, orderId }: LedgerItem) {
  if (!orderId) return null;
  return type === "TRANSFER" ? `/request/${orderId}/receipt` : `/request/${orderId}`;
}

/** One ledger entry. `current` marks the one a link pointed to; it takes focus from the page. */
export function LedgerRow({ entry, current = false }: { entry: LedgerItem; current?: boolean }) {
  const { label, color } = describe(entry);
  const href = errandHref(entry);
  const change = entry.totalChange;
  return (
    <div
      id={ledgerAnchor(entry.transactionId)}
      className={cx(styles.row, current && styles.current)}
      aria-current={current || undefined}
      tabIndex={current ? -1 : undefined}
    >
      <span className={styles.dot} style={{ background: color }} />
      <div className={styles.info}>
        <p className={styles.label}>{href ? <Link href={href}>{label}</Link> : label}</p>
        <p className={styles.detail}>
          Total after: {entry.resultingTotal} · {formatWhen(entry.occurredAt)}
        </p>
      </div>
      <span className={cx(styles.amount, change > 0 && styles.positive, change < 0 && styles.negative)}>
        {change > 0 ? "+" : ""}
        {change}
      </span>
    </div>
  );
}
