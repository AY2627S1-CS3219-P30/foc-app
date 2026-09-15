import type { RequestStatus } from "@/lib/types";

const LABELS: Record<RequestStatus, string> = {
  open: "Open",
  accepted: "Accepted",
  in_transit: "In transit",
  complete: "Complete",
  cancelled: "Cancelled",
};

export function Badge({ status }: { status: RequestStatus }) {
  return <span className={`badge badge--${status}`}>{LABELS[status]}</span>;
}
