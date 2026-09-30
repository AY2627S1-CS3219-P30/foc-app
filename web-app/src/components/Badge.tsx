import type { RequestStatus } from "@/lib/types";
import styles from "./Badge.module.css";

const LABELS: Record<RequestStatus, string> = {
  open: "Open",
  accepted: "Accepted",
  in_transit: "In transit",
  complete: "Complete",
  cancelled: "Cancelled",
};

export function Badge({ status }: { status: RequestStatus }) {
  return <span className={`${styles.badge} ${styles[status]}`}>{LABELS[status]}</span>;
}
