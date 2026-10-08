/**
 * PLT-05 (EI-NFR4.1.1) — one errand's story from one ID. The Order Service and the Credit Service
 * each answer for what they recorded; this lays both out as one list in the order things happened.
 */

import type { DeadLetter, OperatorAlert, OrderCreditTrace, OrderTimeline } from "./admin-api";
import { RECONCILIATION_ACTIONS, type Tone } from "./admin-labels";

export type TraceSource = "Order" | "Credit";

export type TraceEntry = {
  at: string;
  source: TraceSource;
  title: string;
  detail?: string;
  correlationId?: string | null;
  tone: Tone;
};

export const OPERATOR_ALERT_KINDS: Record<OperatorAlert["kind"], string> = {
  CREDIT_WAIT_EXCEEDED: "Waited too long for credits",
  CREDIT_STATE_CONFLICT: "Order and Credit disagree",
};

/** Credit's audit codes; one it adds later still shows, as its code. */
const CREDIT_ALERT_CODES: Record<string, string> = {
  CONFLICTING_REQUEST: "Asked again with different terms",
  INVALID_PARTICIPANTS: "Courier and requester are not valid",
  RESERVATION_NOT_ACTIVE: "No active reservation to settle",
  TERMINAL_OPERATION_CONFLICT: "Already settled another way",
};
export const creditAlertLabel = (code: string) => CREDIT_ALERT_CODES[code] ?? code;

const reconciliation = (action: string) =>
  RECONCILIATION_ACTIONS[action as keyof typeof RECONCILIATION_ACTIONS] ?? action;

function deadLetterEntries(source: TraceSource, letters: DeadLetter[]): TraceEntry[] {
  return letters.flatMap((d) => {
    const parked: TraceEntry = {
      at: d.parkedAt,
      source,
      title: `Dead letter: ${d.eventType ?? "unreadable message"} on ${d.queue}`,
      detail: `${d.failureReason ?? "No reason recorded"} (after ${d.attempts} attempt${d.attempts === 1 ? "" : "s"})`,
      correlationId: d.correlationId,
      tone: d.status === "WAITING" ? "danger" : "neutral",
    };
    if (!d.redrivenAt) return [parked];
    return [
      parked,
      {
        at: d.redrivenAt,
        source,
        title: `Redriven to ${d.queue}`,
        detail: d.redriveReason ?? undefined,
        correlationId: d.correlationId,
        tone: "info",
      },
    ];
  });
}

/** Every recorded step of one errand, oldest first. Either half may be missing. */
export function errandTrace(order?: OrderTimeline, credit?: OrderCreditTrace): TraceEntry[] {
  const entries: TraceEntry[] = [];
  if (order) {
    for (const h of order.history) {
      entries.push({
        at: h.occurredAt,
        source: "Order",
        title: h.previousStatus
          ? `${h.previousStatus} → ${h.newStatus}`
          : `Created, ${h.newStatus}`,
        detail: `${h.action} by ${h.actorType.toLowerCase()}${h.actorId ? ` ${h.actorId}` : ""}`,
        tone: "neutral",
      });
    }
    for (const e of order.events) {
      const failing = !e.publishedAt && e.lastError;
      entries.push({
        // When it was sent, which is what the entry says; the outbox stamps it as it commits.
        at: e.publishedAt ?? e.occurredAt,
        source: "Order",
        title: e.publishedAt ? `Sent ${e.eventType}` : `Not yet sent: ${e.eventType}`,
        detail: failing
          ? `${e.attempts} attempt${e.attempts === 1 ? "" : "s"} so far: ${e.lastError}`
          : undefined,
        correlationId: e.correlationId,
        tone: failing ? "warning" : e.publishedAt ? "neutral" : "info",
      });
    }
    for (const r of order.reconciliation) {
      entries.push({
        at: r.attemptedAt,
        source: "Order",
        title: `Reconciliation: ${reconciliation(r.action)}`,
        detail: `Order said ${r.orderStatus}, Credit said ${r.creditStatus ?? "unknown"}`,
        tone: r.action === "ALERTED" ? "danger" : "warning",
      });
    }
    for (const a of order.alerts) {
      entries.push({
        at: a.raisedAt,
        source: "Order",
        title: `Alert: ${OPERATOR_ALERT_KINDS[a.kind as OperatorAlert["kind"]] ?? a.kind}`,
        tone: "danger",
      });
    }
    entries.push(...deadLetterEntries("Order", order.deadLetters));
  }
  if (credit) {
    for (const o of credit.operations) {
      entries.push({
        at: o.createdAt,
        source: "Credit",
        title: `${o.operationType} ${o.outcome.toLowerCase()}`,
        detail: `${o.amount} credit${o.amount === 1 ? "" : "s"}${o.rejectionReason ? `, ${o.rejectionReason}` : ""}`,
        tone: o.outcome === "REJECTED" ? "warning" : o.outcome === "SUCCEEDED" ? "success" : "info",
      });
    }
    for (const t of credit.transactions) {
      entries.push({
        at: t.occurredAt,
        source: "Credit",
        title: `${t.transactionType} transaction`,
        detail: `${t.amount} credit${t.amount === 1 ? "" : "s"}, ${t.transactionId}`,
        tone: "neutral",
      });
    }
    for (const a of credit.alerts) {
      entries.push({
        at: a.occurredAt,
        source: "Credit",
        title: `Audit alert: ${creditAlertLabel(a.code)}`,
        detail: `${a.operationType} refused`,
        correlationId: a.correlationId,
        tone: "danger",
      });
    }
    entries.push(...deadLetterEntries("Credit", credit.deadLetters));
  }
  // Stable: what happened at the same instant keeps the order above (state change, then its events).
  return entries
    .map((entry, i) => ({ entry, i, t: Date.parse(entry.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ entry }) => entry);
}
