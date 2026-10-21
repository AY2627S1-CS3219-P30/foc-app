import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { ORDER_STATUS, isFinal, rejectionMessage, waitsOnCredit } from "../src/lib/order-status";

/** The `Order.status` union as generated from the contract, so a new state fails here. */
const generated = await readFile(
  new URL("../src/lib/generated/order-service.ts", import.meta.url),
  "utf8",
);
const statuses = [...generated.match(/status: ("PENDING_CREDIT"[^;]*);/)![1]!.matchAll(/"(\w+)"/g)].map(
  (m) => m[1],
);

describe("ORDER_STATUS", () => {
  it("covers exactly the twelve contract states", () => {
    expect(statuses).toHaveLength(12);
    expect(Object.keys(ORDER_STATUS).sort()).toEqual([...statuses].sort());
  });

  it("explains every state in a sentence, the pending ones included", () => {
    for (const { label, explanation } of Object.values(ORDER_STATUS)) {
      expect(label.length).toBeGreaterThan(0);
      expect(explanation).toMatch(/^[A-Z].+\.$/);
    }
    expect(ORDER_STATUS.PENDING_CREDIT.label).toBe("Waiting for credits");
    expect(ORDER_STATUS.COMPLETION_PENDING_CREDIT.label).toBe("Paying the courier");
    expect(ORDER_STATUS.RELEASE_PENDING_CREDIT.label).toBe("Returning credits");
  });

  it("has slow copy for every state that waits on the Credit Service, and no other", () => {
    for (const [status, { slow }] of Object.entries(ORDER_STATUS)) {
      if (waitsOnCredit(status as keyof typeof ORDER_STATUS))
        expect(slow).toMatch(/^This is taking longer than usual\..+come back\.$/);
      else expect(slow).toBeUndefined();
    }
  });
});

describe("isFinal", () => {
  it("is true only for the states no transition leaves", () => {
    expect(statuses.filter((s) => isFinal(s as keyof typeof ORDER_STATUS)).sort()).toEqual([
      "CANCELLED",
      "COMPLETED",
      "EXPIRED",
      "REJECTED",
    ]);
  });
});

describe("waitsOnCredit", () => {
  it("is true only for the states the Credit Service moves the order out of", () => {
    expect(statuses.filter((s) => waitsOnCredit(s as keyof typeof ORDER_STATUS)).sort()).toEqual([
      "COMPLETION_PENDING_CREDIT",
      "PENDING_CREDIT",
      "RELEASE_PENDING_CREDIT",
    ]);
  });
});

describe("rejectionMessage", () => {
  it("uses the available balance the Credit Service reported", () => {
    expect(rejectionMessage({ reward: 5, rejection: { reason: "INSUFFICIENT_CREDITS", available: 3 } })).toBe(
      "You had 3 available for a 5-credit reward. Post it again with a reward of 3 or less, or earn more by delivering errands.",
    );
  });

  it("points a student with no credits to courier work", () => {
    expect(
      rejectionMessage({ reward: 2, rejection: { reason: "INSUFFICIENT_CREDITS", available: 0 } }),
    ).toContain("Delivering errands as a courier is how you earn credits.");
    expect(rejectionMessage({ reward: 2, rejection: { reason: "INSUFFICIENT_CREDITS" } })).toStartWith(
      "You didn't have enough credits for a 2-credit reward.",
    );
  });

  it("explains the other reasons, and an unknown one", () => {
    expect(rejectionMessage({ reward: 9, rejection: { reason: "AMOUNT_OUT_OF_RANGE" } })).toContain(
      "between 1 and 5 credits",
    );
    expect(rejectionMessage({ reward: 1, rejection: { reason: "CONFLICTING_REQUEST" } })).toContain(
      "Post the request again",
    );
    expect(rejectionMessage({ reward: 1, rejection: { reason: "SOMETHING_NEW" } })).toContain(
      "couldn't reserve the reward",
    );
  });
});
