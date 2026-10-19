import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { ApiError } from "../src/lib/api-client";
import {
  clearDraft,
  creditShortfall,
  loadDraft,
  projectedBalance,
  resumeDraft,
  saveDraft,
  submitFailure,
  toCreateOrder,
  validateDraft,
  type Draft,
} from "../src/lib/composer";

const window = new Window();
Object.assign(globalThis, { sessionStorage: window.sessionStorage });
afterAll(() => {
  delete (globalThis as Record<string, unknown>).sessionStorage;
});
beforeEach(() => clearDraft());

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
    const first = resumeDraft(SUPPLIER);
    expect(first.idempotencyKey).toMatch(/^[0-9a-f-]{32,36}$/);
    saveDraft({ ...first, reward: 5 });

    const other = "00000000-0000-4000-8000-000000000002";
    const resumed = resumeDraft(other);
    expect(resumed).toMatchObject({ supplierId: other, reward: 5, idempotencyKey: first.idempotencyKey });
  });

  it("is new once the acknowledged draft is cleared", () => {
    const first = resumeDraft(SUPPLIER);
    saveDraft(first);
    clearDraft();
    expect(loadDraft()).toBeNull();
    expect(resumeDraft(SUPPLIER).idempotencyKey).not.toBe(first.idempotencyKey);
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
          items: [{ name: "Kopi O", quantity: 0, note: "" }],
          deliveryZone: " ",
          deliveryInstructions: "",
          reward: 6,
        }),
      ),
    ).toEqual({
      items: "Item 1 needs a name (up to 200 characters) and a quantity from 1 to 100.",
      deliveryZone: "Enter where the errand should be delivered.",
      deliveryInstructions: "Tell the courier how to hand the items over.",
      reward: "Offer between 1 and 5 credits.",
    });
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
      errors: { items: "Item 2: Too short", deliveryZone: "Required" },
    });
    const bad = new ApiError(400, "VALIDATION_FAILED", "Bad", [
      { field: "reward", code: "too_big", message: "Too big" },
    ]);
    expect(submitFailure(bad)).toEqual({ kind: "fields", errors: { reward: "Too big" } });
  });

  it("says when an earlier version was already sent with this key", () => {
    expect(submitFailure(new ApiError(422, "IDEMPOTENCY_KEY_REUSED", "reused")).kind).toBe("resent");
  });

  it("passes anything else through", () => {
    expect(submitFailure(new ApiError(403, "ACCOUNT_SUSPENDED", "Suspended."))).toEqual({
      kind: "error",
      message: "Suspended.",
    });
  });
});
