import type { Role } from "@/lib/order-actions";
import type { Order, OrderStatus } from "@/lib/order-api";
import { statusWording } from "@/lib/order-status";
import styles from "./Badge.module.css";

type Tone = "neutral" | "info" | "warning" | "success" | "danger";

const TONES: Record<OrderStatus, Tone> = {
  PENDING_CREDIT: "warning",
  OPEN: "neutral",
  ACCEPTED: "info",
  PICKED_UP: "warning",
  DELIVERED: "info",
  DISPUTED: "danger",
  COMPLETION_PENDING_CREDIT: "warning",
  RELEASE_PENDING_CREDIT: "warning",
  REJECTED: "danger",
  COMPLETED: "success",
  CANCELLED: "danger",
  EXPIRED: "neutral",
};

export function Badge({ order, role = null }: { order: Pick<Order, "status" | "releaseReason">; role?: Role }) {
  return (
    <span className={`${styles.badge} ${styles[TONES[order.status]]}`}>{statusWording(order, role).label}</span>
  );
}
