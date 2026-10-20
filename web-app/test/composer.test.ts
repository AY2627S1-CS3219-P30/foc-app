import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { ApiError } from "../src/lib/api-client";
import {
  clearDraft,
  creditShortfall,
  draftFrom,
  itemsError,
  loadDraft,
  projectedBalance,
  resumeDraft,
  saveDraft,
  submitFailure,
  toCreateOrder,
  validateDraft,
  type Draft,
} from "../src/lib/composer";
import type { Order } from "../src/lib/order-api";

const window = new Window();
Object.assign(globalThis, { sessionStorage: window.sessionStorage });
afterAll(() => {
  delete (globalThis as Record<string, unknown>).sessionStorage;
});
beforeEach(() => window.sessionStorage.clear());

const USER = "user-1";
const SUPPLIER = "00000000-0000-4000-8000-000000000001";
const draft = (changes: Partial<Draft> = {}): Draft => ({
  supplierId: SUPPLIER,
  items: [{ name: "Kopi O", quantity: 2, note: "" }],
  deliveryZone: "PGP House 7",
  deliveryInstructions: "Leave it at the lobby counter.",
  reward: 3,
  idempotencyKey: "key-1",
  ...changes,
});

describe("balance", () => {
  it("projects the available balance less exactly the reward", () => {
    expect(projectedBalance(10, 3)).toBe(7);
    expect(projectedBalance(5, 5)).toBe(0);
  });

  it("blocks a reward the wallet cannot cover, and explains zero credits", () => {
    expect(creditShortfall(5, 5)).toBeUndefined();
    expect(creditShortfall(2, 3)).toBe(
      "This reward needs 3 credits and you have 2 available. Lower the reward, or earn more by delivering errands as a courier.",
    );
    expect(creditShortfall(0, 1)).toContain("Delivering errands as a courier is how you earn credits.");
  });
});

describe("idempotency key", () => {
  it("is made once per draft and survives a reload, an edit and a new supplier", () => {
    const first = resumeDraft(USER, SUPPLIER);
    expect(first.idempotencyKey).toMatch(/^[0-9a-f-]{32,36}$/);
    saveDraft(USER, { ...first, reward: 5 });

    const other = "00000000-0000-4000-8000-000000000002";
    const resumed = resumeDraft(USER, other);
    expect(resumed).toMatchObject({ supplierId: other, reward: 5, idempotencyKey: first.idempotencyKey });
  });

  it("is new once the acknowledged draft is cleared", () => {
    const first = resumeDraft(USER, SUPPLIER);
    saveDraft(USER, first);
    clearDraft(USER);
    expect(loadDraft(USER)).toBeNull();
    expect(resumeDraft(USER, SUPPLIER).idempotencyKey).not.toBe(first.idempotencyKey);
  });
});

describe("draft storage", () => {
  it("belongs to one account, so the next one on this tab starts empty", () => {
    saveDraft(USER, draft({ deliveryInstructions: "Room 12, knock twice" }));
    expect(loadDraft("user-2")).toBeNull();
    expect(resumeDraft("user-2", SUPPLIER)).toMatchObject({ deliveryInstructions: "", reward: 1 });
    expect(loadDraft(USER)?.deliveryInstructions).toBe("Room 12, knock twice");
  });
});

describe("draft", () => {
  it("sends trimmed fields and leaves out empty notes", () => {
    expect(
      toCreateOrder(
        draft({
          items: [
            { name: " Kopi O ", quantity: 2, note: "  " },
            { name: "Kaya toast", quantity: 1, note: " no butter " },
          ],
          deliveryZone: " PGP ",
        }),
      ),
    ).toEqual({
      supplierId: SUPPLIER,
      items: [
        { name: "Kopi O", quantity: 2 },
        { name: "Kaya toast", quantity: 1, note: "no butter" },
      ],
      deliveryZone: "PGP",
      deliveryInstructions: "Leave it at the lobby counter.",
      reward: 3,
    });
  });

  it("checks the Order Service's rules before sending", () => {
    expect(validateDraft(draft())).toEqual({});
    expect(
      validateDraft(
        draft({
          items: [
            { name: "Kopi O", quantity: 0, note: "" },
            { name: " ", quantity: 1, note: "" },
          ],
          deliveryZone: " ",
          deliveryInstructions: "",
          reward: 6,
        }),
      ),
    ).toEqual({
      "items.0.quantity": "Enter a quantity from 1 to 100.",
      "items.1.name": "Enter what to get.",
      deliveryZone: "Enter where the errand should be delivered.",
      deliveryInstructions: "Tell the courier how to hand the items over.",
      reward: "Offer between 1 and 5 credits.",
    });
  });
});

describe("draftFrom", () => {
  const rejected = (reward: number, available?: number) =>
    ({
      supplier: { supplierId: SUPPLIER },
      items: [{ name: "Kopi O", quantity: 2 }, { name: "Kaya toast", quantity: 1, note: "no butter" }],
      deliveryZone: "PGP House 7",
      reward,
      rejection: { reason: "INSUFFICIENT_CREDITS", available },
    }) as Order;

  it("copies a rejected order under a new key, at a reward the wallet covered", () => {
    const copy = draftFrom(rejected(5, 2));
    expect(copy).toMatchObject({
      supplierId: SUPPLIER,
      items: [
        { name: "Kopi O", quantity: 2, note: "" },
        { name: "Kaya toast", quantity: 1, note: "no butter" },
      ],
      deliveryZone: "PGP House 7",
      deliveryInstructions: "",
      reward: 2,
    });
    expect(copy.idempotencyKey).not.toBe(draftFrom(rejected(5, 2)).idempotencyKey);
  });

  it("keeps the reward within the allowed range", () => {
    expect(draftFrom(rejected(3)).reward).toBe(3);
    expect(draftFrom(rejected(3, 0)).reward).toBe(1);
    expect(draftFrom(rejected(9)).reward).toBe(5);
  });
});

describe("itemsError", () => {
  it("names the first item with a problem, or gives the list's own", () => {
    expect(itemsError({ "items.1.name": "Too short", reward: "Too big" })).toBe("Item 2: Too short");
    expect(itemsError({ items: "Add at least one item.", "items.0.name": "Too short" })).toBe(
      "Add at least one item.",
    );
    expect(itemsError({ reward: "Too big" })).toBeUndefined();
  });
});

describe("submitFailure", () => {
  it("sends an inactive supplier back to the picker", () => {
    expect(submitFailure(new ApiError(422, "INVALID_SUPPLIER", "The supplier is not active."))).toEqual({
      kind: "supplier",
      message: "The supplier is not active.",
    });
  });

  it("offers a retry with the same key when the service or network is down", () => {
    for (const err of [
      new ApiError(503, "SUPPLIER_SERVICE_UNAVAILABLE", "down"),
      new ApiError(500, "INTERNAL", "broken"),
      new ApiError(502, "BAD_GATEWAY", "gateway"),
      new ApiError(0, "NETWORK", "offline"),
      new ApiError(0, "TIMEOUT", "slow"),
    ])
      expect(submitFailure(err).kind).toBe("retry");
  });

  it("maps field errors onto the composer's fields", () => {
    const err = new ApiError(422, "VALIDATION_FAILED", "The order request is invalid.", [
      { field: "items.1.name", code: "too_small", message: "Too short" },
      { field: "items.0.quantity", code: "too_small", message: "Too small" },
      { field: "deliveryZone", code: "too_small", message: "Required" },
    ]);
    expect(submitFailure(err)).toEqual({
      kind: "fields",
      errors: { "items.1.name": "Too short", "items.0.quantity": "Too small", deliveryZone: "Required" },
    });
    const bad = new ApiError(400, "VALIDATION_FAILED", "Bad", [
      { field: "reward", code: "too_big", message: "Too big" },
    ]);
    expect(submitFailure(bad)).toEqual({ kind: "fields", errors: { reward: "Too big" } });
  });

  it("says when an earlier version was already sent with this key", () => {
    expect(submitFailure(new ApiError(422, "IDEMPOTENCY_KEY_REUSED", "reused"))).toEqual({
      kind: "error",
      message: expect.stringContaining("already sent"),
    });
  });

  it("does not offer a retry for a build without the service's address", () => {
    expect(submitFailure(new ApiError(0, "NOT_CONFIGURED", "Missing address."))).toEqual({
      kind: "error",
      message: "Missing address.",
    });
  });

  it("passes anything else through", () => {
    expect(submitFailure(new ApiError(403, "ACCOUNT_SUSPENDED", "Suspended."))).toEqual({
      kind: "error",
      message: "Suspended.",
    });
  });
});
