"use client";

import type { AccountErrandPage } from "@/lib/admin-api";
import { formatWhen, ORDER_STATUSES, ORDER_TONES } from "@/lib/admin-labels";
import { Tag, TraceLink } from "./ui";
import styles from "./admin.module.css";

/** A page of errands from the Order Service's admin list: public fields only, each linked to its trace. */
export function ErrandTable({ page, caption }: { page: AccountErrandPage; caption: string }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="srOnly">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Errand</th>
            <th scope="col">Status</th>
            <th scope="col">Supplier</th>
            <th scope="col" className={styles.number}>
              Reward
            </th>
            <th scope="col">Posted</th>
            <th scope="col">Last change</th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((e) => (
            <tr key={e.orderId}>
              <td>
                <TraceLink orderId={e.orderId} />
              </td>
              <td>
                <Tag tone={ORDER_TONES[e.status]}>{ORDER_STATUSES[e.status]}</Tag>
              </td>
              <td>{e.supplier.name}</td>
              <td className={styles.number}>{e.reward}</td>
              <td className={styles.nowrap}>{formatWhen(e.createdAt)}</td>
              <td className={styles.nowrap}>{formatWhen(e.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
