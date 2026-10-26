import Link from "next/link";
import type { ReactNode } from "react";
import { itemsLabel } from "@/lib/composer";
import type { Role } from "@/lib/order-actions";
import type { Order, OrderItem } from "@/lib/order-api";
import { Badge } from "./Badge";
import styles from "./ErrandCard.module.css";

type Errand = Pick<Order, "orderId" | "supplier" | "deliveryZone" | "reward" | "status" | "releaseReason"> & {
  items: OrderItem[];
};

/** Lays errand cards out in as many columns as fit. */
export function ErrandGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}

/**
 * One errand in a list. The card is a link to the errand; `details` and `action` sit after it, not
 * inside, so the link's name stays short and no control is nested in it.
 */
export function ErrandCard({
  errand,
  role,
  meta,
  details,
  action,
}: {
  errand: Errand;
  role?: Role;
  meta?: ReactNode;
  details?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`card ${styles.card}`}>
      <Link href={`/request/${errand.orderId}`} className={styles.link}>
        <div className={styles.meta}>
          <Badge order={errand} role={role} />
          {meta && <span className={styles.when}>{meta}</span>}
        </div>
        <div className={styles.body}>
          <p className={styles.title}>{errand.supplier.name}</p>
          <p className={styles.items}>{itemsLabel(errand.items)}</p>
          <p className={styles.zone}>To {errand.deliveryZone}</p>
        </div>
      </Link>
      {details && <div className={styles.details}>{details}</div>}
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
