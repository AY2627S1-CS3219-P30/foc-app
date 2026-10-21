import { describe, expect, it } from "bun:test";
import { ApiError } from "../src/lib/api-client";
import type { Order, OrderStatus } from "../src/lib/order-api";
import { actionsFor, roleIn, staleMessage, tookEffect, type Role } from "../src/lib/order-actions";
import { ORDER_STATUS } from "../src/lib/order-status";

const NOW = Date.parse("2026-10-21T10:00:00.000Z");
const LATER = "2026-10-21T12:00:00.000Z";
const EARLIER = "2026-10-21T08:00:00.000Z";

const order = (status: OrderStatus, changes: Partial<Order> = {}): Order => ({
  orderId: "11111111-0000-4000-8000-000000000001",
  supplier: {
    supplierId: "00000000-0000-4000-8000-000000000001",
    name: "Kopi Corner",
    type: "CAFE",
    building: "COM2",
    floor: "1",
    locationDescription: "By the stairs",
  },
  items: [{ name: "Kopi O", quantity: 1 }],
  deliveryZone: "PGP",
  reward: 2,
  status,
  version: 3,
  acceptanceDeadlineAt: LATER,
  createdAt: EARLIER,
  updatedAt: EARLIER,
  serverTime: new Date(NOW).toISOString(),
  ...(status === "PICKED_UP" ? { nonDeliveryReportAt: LATER } : {}),
  ...(status === "DELIVERED" ? { autoConfirmAt: LATER } : {}),
  ...changes,
});

const commands = (o: Order, role: Role, now = NOW) => actionsFor(o, role, now).map((a) => a.command);

/** The transition table in order-service/README.md, for every status and actor, before any deadline. */
const EXPECTED: Record<OrderStatus, Record<"REQUESTER" | "COURIER" | "OTHER", string[]>> = {
  PENDING_CREDIT: { REQUESTER: [], COURIER: [], OTHER: [] },
  OPEN: { REQUESTER: ["cancel"], COURIER: [], OTHER: ["accept"] },
  ACCEPTED: { REQUESTER: ["cancel"], COURIER: ["pickup", "withdraw"], OTHER: [] },
  PICKED_UP: { REQUESTER: [], COURIER: ["deliver"], OTHER: [] },
  DELIVERED: { REQUESTER: ["confirmReceipt", "reportNonReceipt"], COURIER: [], OTHER: [] },
  DISPUTED: { REQUESTER: [], COURIER: [], OTHER: [] },
  COMPLETION_PENDING_CREDIT: { REQUESTER: [], COURIER: [], OTHER: [] },
  RELEASE_PENDING_CREDIT: { REQUESTER: [], COURIER: [], OTHER: [] },
  REJECTED: { REQUESTER: [], COURIER: [], OTHER: [] },
  COMPLETED: { REQUESTER: [], COURIER: [], OTHER: [] },
  CANCELLED: { REQUESTER: [], COURIER: [], OTHER: [] },
  EXPIRED: { REQUESTER: [], COURIER: [], OTHER: [] },
};

describe("actionsFor", () => {
  for (const status of Object.keys(ORDER_STATUS) as OrderStatus[]) {
    it(`offers each actor only the table's actions while ${status}`, () => {
      const o = order(status);
      expect(commands(o, "REQUESTER")).toEqual(EXPECTED[status].REQUESTER);
      expect(commands(o, "COURIER")).toEqual(EXPECTED[status].COURIER);
      expect(commands(o, null)).toEqual(EXPECTED[status].OTHER);
    });
  }

  it("stops offering acceptance once the deadline passes", () => {
    expect(commands(order("OPEN", { acceptanceDeadlineAt: EARLIER }), null)).toEqual([]);
  });

  it("stops offering acceptance at the deadline itself, as the server does", () => {
    const o = order("OPEN");
    expect(commands(o, null, Date.parse(LATER) - 1)).toEqual(["accept"]);
    expect(commands(o, null, Date.parse(LATER))).toEqual([]);
  });

  it("still offers withdrawal and cancellation after the acceptance deadline", () => {
    const late = { acceptanceDeadlineAt: EARLIER };
    expect(commands(order("ACCEPTED", late), "COURIER")).toEqual(["pickup", "withdraw"]);
    expect(commands(order("ACCEPTED", late), "REQUESTER")).toEqual(["cancel"]);
    expect(commands(order("OPEN", late), "REQUESTER")).toEqual(["cancel"]);
  });

  it("offers the non-delivery report from the moment the delivery period ends", () => {
    const o = order("PICKED_UP");
    expect(commands(o, "REQUESTER", Date.parse(LATER) - 1)).toEqual([]);
    expect(commands(o, "REQUESTER", Date.parse(LATER))).toEqual(["reportNonDelivery"]);
  });

  it("stops offering the non-receipt report once the errand auto-confirms", () => {
    const o = order("DELIVERED");
    expect(commands(o, "REQUESTER", Date.parse(LATER) - 1)).toEqual(["confirmReceipt", "reportNonReceipt"]);
    expect(commands(o, "REQUESTER", Date.parse(LATER))).toEqual(["confirmReceipt"]);
  });

  it("asks for confirmation on every action", () => {
    for (const status of Object.keys(ORDER_STATUS) as OrderStatus[])
      for (const role of ["REQUESTER", "COURIER", null] as Role[])
        for (const action of actionsFor(order(status), role, NOW)) {
          expect(action.confirm.title).toBeTruthy();
          expect(action.confirm.body).toBeTruthy();
        }
  });
});

describe("roleIn", () => {
  it("reads the role from the participant IDs only the private projection carries", () => {
    expect(roleIn({ requesterId: "me", courierId: "them" }, "me")).toBe("REQUESTER");
    expect(roleIn({ requesterId: "them", courierId: "me" }, "me")).toBe("COURIER");
    expect(roleIn({}, "me")).toBeNull();
    expect(roleIn({ requesterId: "me" }, undefined)).toBeNull();
  });
});

describe("staleMessage", () => {
  it("explains the refusals that mean the errand moved on", () => {
    expect(staleMessage(new ApiError(409, "ORDER_NOT_OPEN", ""))).toContain("Another courier");
    expect(staleMessage(new ApiError(403, "SELF_ACCEPTANCE_FORBIDDEN", ""))).toContain("your own errand");
    expect(staleMessage(new ApiError(409, "DELIVERY_PERIOD_NOT_PASSED", ""))).toContain("too early");
    expect(staleMessage(new ApiError(409, "AUTO_CONFIRMATION_PASSED", ""))).toContain("confirmed automatically");
    expect(staleMessage(new ApiError(409, "ACCEPTANCE_DEADLINE_PASSED", ""))).toContain("deadline passed");
    expect(staleMessage(new ApiError(409, "ORDER_CHANGED", ""))).toContain("changed before your request");
    expect(staleMessage(new ApiError(409, "INVALID_ORDER_STATE", ""))).toContain("changed before your request");
    expect(staleMessage(new ApiError(403, "ACTION_FORBIDDEN", ""))).toContain("can't do that");
    expect(staleMessage(new ApiError(404, "NOT_FOUND", ""))).toContain("no longer available");
  });

  it("leaves failures worth retrying to the dialog", () => {
    expect(staleMessage(new ApiError(0, "NETWORK", ""))).toBeNull();
    expect(staleMessage(new ApiError(503, "INTERNAL", ""))).toBeNull();
    expect(staleMessage(new ApiError(422, "VALIDATION_FAILED", ""))).toBeNull();
  });
});

describe("tookEffect", () => {
  const mine = { requesterId: "them", courierId: "me" };

  it("knows a lost accept went through when the errand is theirs", () => {
    expect(tookEffect("accept", order("ACCEPTED", mine), "me")).toBe(true);
    expect(tookEffect("accept", order("ACCEPTED", { courierId: "other" }), "me")).toBe(false);
    expect(tookEffect("accept", order("OPEN"), undefined)).toBe(false);
  });

  it("knows a lost step went through when the errand is where that step leads", () => {
    expect(tookEffect("pickup", order("PICKED_UP", mine), "me")).toBe(true);
    expect(tookEffect("pickup", order("ACCEPTED", mine), "me")).toBe(false);
    expect(tookEffect("deliver", order("DELIVERED", mine), "me")).toBe(true);
    expect(tookEffect("withdraw", order("OPEN"), "me")).toBe(true);
    expect(tookEffect("withdraw", order("ACCEPTED", mine), "me")).toBe(false);
    expect(tookEffect("cancel", order("RELEASE_PENDING_CREDIT", { releaseReason: "CANCELLED" }), "me")).toBe(true);
    expect(tookEffect("cancel", order("RELEASE_PENDING_CREDIT", { releaseReason: "EXPIRED" }), "me")).toBe(false);
    expect(tookEffect("confirmReceipt", order("COMPLETED"), "me")).toBe(true);
    expect(tookEffect("reportNonReceipt", order("DISPUTED"), "me")).toBe(true);
    expect(tookEffect("reportNonDelivery", order("PICKED_UP"), "me")).toBe(false);
  });
});
