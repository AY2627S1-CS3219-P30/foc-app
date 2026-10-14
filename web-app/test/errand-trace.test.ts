import { describe, expect, it } from "bun:test";
import type { OrderCreditTrace, OrderTimeline } from "../src/lib/admin-api";
import { creditAlertLabel, errandTrace } from "../src/lib/errand-trace";

const orderId = "0198a1c2-0000-7000-8000-0000000000f1";
const at = (minute: number) => `2026-10-08T08:${String(minute).padStart(2, "0")}:00.000Z`;

const deadLetter = {
  id: "0198a1c2-0000-7000-8000-0000000000d1",
  queue: "foc.order.reservation-results",
  eventId: "e-2",
  eventType: "credit.reserved",
  aggregateId: orderId,
  correlationId: "trace-1",
  failureReason: "order version moved on",
  attempts: 5,
  status: "REDRIVEN" as const,
  parkedAt: at(4),
  redrivenAt: at(6),
  redrivenBy: "admin-1",
  redriveReason: "conflict resolved",
};

const timeline: OrderTimeline = {
  orderId,
  status: "OPEN",
  requesterId: "student-1",
  courierId: null,
  reward: 3,
  version: 2,
  creditTransactionId: "tx-1",
  createdAt: at(0),
  updatedAt: at(7),
  history: [
    {
      previousStatus: null,
      newStatus: "PENDING_CREDIT",
      action: "CREATE",
      actorType: "STUDENT",
      actorId: "student-1",
      version: 1,
      occurredAt: at(0),
    },
    {
      previousStatus: "PENDING_CREDIT",
      newStatus: "OPEN",
      action: "CREDIT_RESERVED",
      actorType: "SYSTEM",
      actorId: null,
      version: 2,
      occurredAt: at(7),
    },
  ],
  events: [
    {
      eventId: "e-1",
      eventType: "credit.reservation-requested",
      correlationId: "trace-1",
      causationId: null,
      occurredAt: at(0),
      publishedAt: at(0),
      attempts: 1,
      lastError: null,
    },
  ],
  reconciliation: [],
  alerts: [{ kind: "CREDIT_WAIT_EXCEEDED", raisedAt: at(5), detail: {} }],
  deadLetters: [deadLetter],
};

const credit: OrderCreditTrace = {
  orderId,
  operations: [
    {
      operationType: "RESERVE",
      requesterId: "student-1",
      courierId: null,
      amount: 3,
      outcome: "SUCCEEDED",
      rejectionReason: null,
      transactionId: "tx-1",
      createdAt: at(1),
    },
  ],
  transactions: [
    {
      transactionId: "tx-1",
      transactionType: "RESERVE",
      walletUserId: "student-1",
      amount: 3,
      occurredAt: at(1),
    },
  ],
  alerts: [],
  deadLetters: [],
};

describe("an errand's trace", () => {
  it("lays both services' records out in the order they happened", () => {
    const entries = errandTrace(timeline, credit);
    expect(entries.map((e) => [e.at, e.source, e.title])).toEqual([
      [at(0), "Order", "Created, PENDING_CREDIT"],
      [at(0), "Order", "Sent credit.reservation-requested"],
      [at(1), "Credit", "RESERVE succeeded"],
      [at(1), "Credit", "RESERVE transaction"],
      [at(4), "Order", "Dead letter: credit.reserved on foc.order.reservation-results"],
      [at(5), "Order", "Alert: Waited too long for credits"],
      [at(6), "Order", "Redriven to foc.order.reservation-results"],
      [at(7), "Order", "PENDING_CREDIT → OPEN"],
    ]);
    expect(entries[4]).toMatchObject({
      detail: "order version moved on (after 5 attempts)",
      correlationId: "trace-1",
      tone: "neutral",
    });
    expect(entries[6]).toMatchObject({ detail: "conflict resolved", tone: "info" });
  });

  it("places a sent event when it was sent, not a moment before the change that caused it", () => {
    const entries = errandTrace({
      ...timeline,
      // The app's clock stamps the event a millisecond before the database stamps the change.
      events: [{ ...timeline.events[0], occurredAt: "2026-10-08T07:59:59.999Z", publishedAt: at(1) }],
    });
    expect(entries.map((e) => e.title).slice(0, 2)).toEqual([
      "Created, PENDING_CREDIT",
      "Sent credit.reservation-requested",
    ]);
    expect(entries[1].at).toBe(at(1));
  });

  it("marks a dead letter still waiting, and an event the outbox keeps failing to send", () => {
    const entries = errandTrace({
      ...timeline,
      events: [{ ...timeline.events[0], publishedAt: null, attempts: 3, lastError: "broker down" }],
      deadLetters: [{ ...deadLetter, status: "WAITING", redrivenAt: null }],
    });
    expect(entries.find((e) => e.title.startsWith("Dead letter"))?.tone).toBe("danger");
    expect(entries.find((e) => e.title.startsWith("Not yet sent"))).toMatchObject({
      detail: "3 attempts so far: broker down",
      tone: "warning",
    });
    expect(entries.some((e) => e.title.startsWith("Redriven"))).toBe(false);
  });

  it("shows whichever half answered", () => {
    expect(errandTrace(undefined, credit).every((e) => e.source === "Credit")).toBe(true);
    expect(errandTrace(timeline, undefined).every((e) => e.source === "Order")).toBe(true);
    expect(errandTrace()).toEqual([]);
  });

  it("names Credit's audit codes, and shows a new one as its code", () => {
    expect(creditAlertLabel("CONFLICTING_REQUEST")).toBe("Asked again with different terms");
    expect(creditAlertLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});
