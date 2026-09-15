import { Badge } from "./Badge";
import type { ErrandRequest } from "@/lib/types";
import styles from "./OrdersTable.module.css";

export function OrdersTable({ requests }: { requests: ErrandRequest[] }) {
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Order</th>
            <th>Requester</th>
            <th>Courier</th>
            <th>Status</th>
            <th>Credits</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td>#{r.id}</td>
              <td>{r.requesterName}</td>
              <td>{r.courierName ?? "—"}</td>
              <td>
                <Badge status={r.status} />
              </td>
              <td>{r.credits}</td>
              <td>
                {new Date(r.createdAt).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
