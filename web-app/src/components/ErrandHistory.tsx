"use client";

import { formatWhen } from "@/lib/admin-labels";
import type { OrderHistory, OrderStatus } from "@/lib/order-api";
import { ORDER_STATUS } from "@/lib/order-status";
import { vars } from "@/styles/tokens";
import { ErrorState, LoadingState } from "./States";

type Entry = OrderHistory["entries"][number];
const decisions: Record<string, string> = {
  RESOLVE_FOR_COURIER: "Decided for the courier",
  RESOLVE_FOR_REQUESTER: "Decided for the requester",
};

export function ErrandHistory({
  history,
  error,
  retry,
}: {
  history: OrderHistory | null;
  error: string | null;
  retry: () => void;
}) {
  // The API returns history in version order. Only explicit admin decisions carry a decision reason.
  const decision = history?.entries.findLast(
    (entry) => entry.actorType === "ADMIN" && decisions[entry.action],
  );
  const label = (entry: Entry) =>
    (entry.actorType === "ADMIN" && decisions[entry.action]) ||
    ORDER_STATUS[entry.newStatus as OrderStatus]?.label ||
    "Status changed";
  return (
    <section
      aria-label="Errand history"
      style={{ display: "flex", flexDirection: "column", gap: vars.space[3], overflowWrap: "anywhere" }}
    >
      <h2 style={{ fontSize: vars.text.lg, fontWeight: vars.weight.semibold }}>Errand history</h2>
      {error ? (
        <ErrorState title="Could not load errand history" onRetry={retry}>
          {error}
        </ErrorState>
      ) : !history ? (
        <LoadingState label="Loading errand history…" rows={1} />
      ) : (
        <>
          {decision && (
            <div role="status">
              <h3 style={{ fontSize: vars.text.md, fontWeight: vars.weight.semibold }}>
                {decisions[decision.action]}
              </h3>
              <p>
                An administrator made this decision on{" "}
                <time dateTime={decision.occurredAt}>{formatWhen(decision.occurredAt)}</time>.
              </p>
              <p>{decision.reason ?? "No reason was recorded."}</p>
            </div>
          )}
          <details>
            <summary style={{ minHeight: vars.size.control, paddingBlock: vars.space[2], cursor: "pointer" }}>
              View status history
            </summary>
            {history.entries.length === 0 ? (
              <p>No status changes recorded yet.</p>
            ) : (
              <ol>
                {history.entries.map((entry) => (
                  <li key={entry.version} style={{ marginBlock: vars.space[3] }}>
                    <p>{label(entry)}</p>
                    <time dateTime={entry.occurredAt}>{formatWhen(entry.occurredAt)}</time>
                  </li>
                ))}
              </ol>
            )}
          </details>
        </>
      )}
    </section>
  );
}
