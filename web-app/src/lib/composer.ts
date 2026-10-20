import { ApiError, newCorrelationId } from "./api-client";
import type { CreateOrder, Order, OrderItem } from "./order-api";
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
  /** The first body sent under the key: what the server holds if that response was lost. */
  sentBody?: CreateOrder;
  /** What the Order Service rejected, shown again on the details form. */
  errors?: DraftErrors;
};

type ItemField = `items.${number}.${"name" | "quantity" | "note"}`;
/** The Order Service's field paths, so its errors land on the same fields. */
export type DraftField =
  | "supplierId"
  | "items"
  | ItemField
  | "deliveryZone"
  | "deliveryInstructions"
  | "reward";
export type DraftErrors = Partial<Record<DraftField, string>>;

/** Per account, so a draft never prefills the form for someone else signing in on this tab. */
const storageKey = (userId: string) => `foc.request-draft:${userId}`;

export function loadDraft(userId: string): Draft | null {
  try {
    return JSON.parse(sessionStorage.getItem(storageKey(userId)) ?? "null");
  } catch {
    return null;
  }
}

export function saveDraft(userId: string, draft: Draft) {
  sessionStorage.setItem(storageKey(userId), JSON.stringify(draft));
}

export function clearDraft(userId: string) {
  sessionStorage.removeItem(storageKey(userId));
}

/** The stored draft, now for this supplier, or a new one with its own key (a UUID, even on HTTP). */
export function resumeDraft(userId: string, supplierId: string): Draft {
  return {
    items: [{ name: "", quantity: 1, note: "" }],
    deliveryZone: "",
    deliveryInstructions: "",
    reward: REWARD_MIN,
    idempotencyKey: newCorrelationId(),
    ...loadDraft(userId),
    supplierId,
  };
}

/** A new draft, with its own key, copying a rejected order at a reward the wallet covered. */
export function draftFrom(order: Order): Draft {
  const reward = Math.min(order.reward, order.rejection?.available ?? order.reward, REWARD_MAX);
  return {
    supplierId: order.supplier.supplierId,
    items: order.items.map(({ name, quantity, note = "" }) => ({ name, quantity, note })),
    deliveryZone: order.deliveryZone,
    deliveryInstructions: order.deliveryInstructions ?? "",
    reward: Math.max(reward, REWARD_MIN),
    idempotencyKey: newCorrelationId(),
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
  if (!draft.items.length) errors.items = "Add at least one item.";
  else if (draft.items.length > 50) errors.items = "Add at most 50 items.";
  draft.items.forEach(({ name, quantity, note }, i) => {
    if (!name.trim()) errors[`items.${i}.name`] = "Enter what to get.";
    else if (name.trim().length > 200) errors[`items.${i}.name`] = "Use at most 200 characters.";
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100)
      errors[`items.${i}.quantity`] = "Enter a quantity from 1 to 100.";
    if (note.trim().length > 500) errors[`items.${i}.note`] = "Use at most 500 characters.";
  });
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

/** The items' first problem, naming the item, for the review that has no item fields. */
export function itemsError(errors: DraftErrors): string | undefined {
  if (errors.items) return errors.items;
  const [field, message] = Object.entries(errors).find(([f]) => f.startsWith("items.")) ?? [];
  return field && `Item ${Number(field.split(".")[1]) + 1}: ${message}`;
}

export type SubmitFailure =
  | { kind: "supplier"; message: string }
  | { kind: "fields"; errors: DraftErrors }
  | { kind: "retry"; message: string }
  | { kind: "error"; message: string };

const RETRY = "We couldn't send your request. Try again — it won't be posted twice.";

/** The key already holds a different body: an earlier version whose response was lost. */
export const keyReused = (err: unknown) =>
  err instanceof ApiError && err.code === "IDEMPOTENCY_KEY_REUSED";

/** What a failed `POST /orders` means for the composer. `retry` keeps the same key. */
export function submitFailure(err: unknown): SubmitFailure {
  if (!(err instanceof ApiError)) return { kind: "retry", message: RETRY };
  if (err.code === "INVALID_SUPPLIER") return { kind: "supplier", message: err.message };
  if (err.code === "NOT_CONFIGURED") return { kind: "error", message: err.message };
  if (err.code === "IDEMPOTENCY_KEY_REUSED")
    return {
      kind: "error",
      message:
        "An earlier version of this request was already sent. Check your order history before posting it again.",
    };
  if (err.status === 0 || err.status >= 500) return { kind: "retry", message: RETRY };
  if ((err.status === 400 || err.status === 422) && err.details.length) {
    const errors: DraftErrors = {};
    for (const { field, message } of err.details) errors[field as DraftField] ??= message;
    return { kind: "fields", errors };
  }
  return { kind: "error", message: err.message };
}
