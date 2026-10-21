import Link from "next/link";
import type { ReactNode } from "react";
import type { Order } from "@/lib/order-api";
import { Badge } from "./Badge";
import styles from "./ErrandCard.module.css";

type Errand = Pick<Order, "orderId" | "supplier" | "deliveryZone" | "reward" | "status"> & {
  items: { name: string; quantity: number }[];
};

const summary = (items: Errand["items"]) => items.map((i) => `${i.quantity} × ${i.name}`).join(", ");

/**
 * One errand in a list. The card is a link to the errand; `action` sits beside it, not inside,
 * since a button nested in a link is invalid and unreachable for some assistive technology.
 */
export function ErrandCard({
  errand,
  meta,
  action,
}: {
  errand: Errand;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`card ${styles.card}`}>
      <Link href={`/request/${errand.orderId}`} className={styles.link}>
        <div className={styles.meta}>
          <Badge status={errand.status} />
          {meta && <span className={styles.when}>{meta}</span>}
        </div>
        <div className={styles.body}>
          <p className={styles.title}>{errand.supplier.name}</p>
          <p className={styles.items}>{summary(errand.items)}</p>
          <p className={styles.zone}>To {errand.deliveryZone}</p>
        </div>
      </Link>
      <div className={styles.action}>
        <div className={styles.reward}>
          <strong>{errand.reward}</strong>
          <span>{errand.reward === 1 ? "credit" : "credits"}</span>
        </div>
        {action}
      </div>
    </div>
  );
}
