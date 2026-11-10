// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-09-30 to 2026-10-22
// Scope: Implementation for "request composer on the Order API" (WEB-00, WEB-01, WEB-03); also bug
//   fixes.
// Author review: Patrick Thomas reviewed the implementation for correctness, ran it against the
//   test suite, and checked that it fits our service boundaries without fatal errors before
//   committing.

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
