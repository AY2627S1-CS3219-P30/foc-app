import { ApiError, newCorrelationId } from "./api-client";
import type { CreateOrder, OrderItem } from "./order-api";
import type { Supplier } from "./supplier-api";

/** How long an errand stays open once its credits are reserved (the Order Service's default). */
export const OPEN_PERIOD_MINUTES = 60;

export const REWARD_MIN = 1;
export const REWARD_MAX = 5;

export type DraftItem = { name: string; quantity: number; note: string };

/**
 * What the composer has so far. The idempotency key is made once per draft and kept until the
 * server acknowledges the order, so every retry, reload or edit after a lost response replays the
 * same submission instead of creating a second errand.
 */
export type Draft = {
  supplierId: string;
  items: DraftItem[];
  deliveryZone: string;
  deliveryInstructions: string;
  reward: number;
  idempotencyKey: string;
};

export type DraftField = "supplierId" | "items" | "deliveryZone" | "deliveryInstructions" | "reward";
export type DraftErrors = Partial<Record<DraftField, string>>;

const STORAGE_KEY = "foc.request-draft";

export function loadDraft(): Draft | null {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return null;
  }
}

export function saveDraft(draft: Draft) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
}

export function clearDraft() {
  sessionStorage.removeItem(STORAGE_KEY);
}

/** The stored draft, now for this supplier, or a new one with its own key (a UUID, even on HTTP). */
export function resumeDraft(supplierId: string): Draft {
  return {
    items: [{ name: "", quantity: 1, note: "" }],
    deliveryZone: "",
    deliveryInstructions: "",
    reward: REWARD_MIN,
    idempotencyKey: newCorrelationId(),
    ...loadDraft(),
    supplierId,
  };
}

export const pickupLabel = (supplier: Supplier) =>
  `${supplier.name} — ${supplier.building}, floor ${supplier.floor}`;

export const itemsLabel = (items: OrderItem[]) =>
  items.map((i) => `${i.quantity} × ${i.name}${i.note ? ` (${i.note})` : ""}`).join(", ");

export function toCreateOrder(draft: Draft): CreateOrder {
  return {
    supplierId: draft.supplierId,
    items: draft.items.map(({ name, quantity, note }) => ({
      name: name.trim(),
      quantity,
      ...(note.trim() && { note: note.trim() }),
    })),
    deliveryZone: draft.deliveryZone.trim(),
    deliveryInstructions: draft.deliveryInstructions.trim(),
    reward: draft.reward,
  };
}

/** Mirrors the Order Service's rules, so an obvious mistake is caught before a round trip. */
export function validateDraft(draft: Draft): DraftErrors {
  const errors: DraftErrors = {};
  const itemProblem = draft.items.findIndex(
    (i) =>
      !i.name.trim() ||
      i.name.trim().length > 200 ||
      !Number.isInteger(i.quantity) ||
      i.quantity < 1 ||
      i.quantity > 100 ||
      i.note.trim().length > 500,
  );
  if (!draft.items.length) errors.items = "Add at least one item.";
  else if (draft.items.length > 50) errors.items = "Add at most 50 items.";
  else if (itemProblem >= 0)
    errors.items = `Item ${itemProblem + 1} needs a name (up to 200 characters) and a quantity from 1 to 100.`;
  if (!draft.deliveryZone.trim()) errors.deliveryZone = "Enter where the errand should be delivered.";
  else if (draft.deliveryZone.trim().length > 200) errors.deliveryZone = "Use at most 200 characters.";
  if (!draft.deliveryInstructions.trim())
    errors.deliveryInstructions = "Tell the courier how to hand the items over.";
  else if (draft.deliveryInstructions.trim().length > 1000)
    errors.deliveryInstructions = "Use at most 1000 characters.";
  if (!Number.isInteger(draft.reward) || draft.reward < REWARD_MIN || draft.reward > REWARD_MAX)
    errors.reward = `Offer between ${REWARD_MIN} and ${REWARD_MAX} credits.`;
  return errors;
}

/** The Credit Service reserves exactly the reward, so this is the available balance afterwards. */
export const projectedBalance = (available: number, reward: number) => available - reward;

/** Why the wallet cannot cover this reward, or `undefined` when it can. */
export function creditShortfall(available: number, reward: number): string | undefined {
  if (available <= 0)
    return "You have no credits available, so you can't post a request yet. Delivering errands as a courier is how you earn credits.";
  if (available < reward)
    return `This reward needs ${reward} credits and you have ${available} available. Lower the reward, or earn more by delivering errands as a courier.`;
}

export type SubmitFailure =
  | { kind: "supplier"; message: string }
  | { kind: "fields"; errors: DraftErrors }
  | { kind: "retry"; message: string }
  | { kind: "resent"; message: string }
  | { kind: "error"; message: string };

const RETRY = "We couldn't send your request. Try again — it won't be posted twice.";

/** What a failed `POST /orders` means for the composer. `retry` keeps the same key. */
export function submitFailure(err: unknown): SubmitFailure {
  if (!(err instanceof ApiError)) return { kind: "retry", message: RETRY };
  if (err.code === "INVALID_SUPPLIER") return { kind: "supplier", message: err.message };
  if (err.code === "IDEMPOTENCY_KEY_REUSED")
    return {
      kind: "resent",
      message:
        "An earlier version of this request was already sent. Check your order history before posting it again.",
    };
  if (err.status === 0 || err.status === 503) return { kind: "retry", message: RETRY };
  if ((err.status === 400 || err.status === 422) && err.details.length) {
    const errors: DraftErrors = {};
    for (const { field, message } of err.details) {
      const [name, index] = field.split(".");
      const key = name as DraftField;
      errors[key] ??= key === "items" && index ? `Item ${Number(index) + 1}: ${message}` : message;
    }
    return { kind: "fields", errors };
  }
  return { kind: "error", message: err.message };
}
