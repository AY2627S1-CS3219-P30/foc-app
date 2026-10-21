import type { ApiError } from "./api-client";
import type { Command, Order } from "./order-api";

/** `null` is a student with no part in the errand: they may only accept it. */
export type Role = "REQUESTER" | "COURIER" | null;

export type OrderAction = {
  command: Command;
  label: string;
  variant: "primary" | "outline";
  /** It can't be taken back, so its dialog starts on "Go back" rather than on confirming. */
  destructive?: true;
  confirm: { title: string; body: string; label: string };
};

type Actor = Pick<Order, "requesterId" | "courierId">;

/** The private projection names both participants; anyone else gets the public one, without them. */
export function roleIn(order: Actor, userId: string | undefined): Role {
  if (!userId) return null;
  if (order.requesterId === userId) return "REQUESTER";
  if (order.courierId === userId) return "COURIER";
  return null;
}

export const ORDER_ACTIONS: Record<Command, OrderAction> = {
  accept: {
    command: "accept",
    label: "Accept errand",
    variant: "primary",
    confirm: {
      title: "Accept this errand?",
      body: "You'll be its courier. The exact delivery instructions appear once it's yours.",
      label: "Accept",
    },
  },
  pickup: {
    command: "pickup",
    label: "I've picked it up",
    variant: "primary",
    confirm: {
      title: "Record pickup?",
      body: "The requester will see that the items are on the way.",
      label: "Record pickup",
    },
  },
  deliver: {
    command: "deliver",
    label: "Mark as delivered",
    variant: "primary",
    confirm: {
      title: "Record delivery?",
      body: "The requester then confirms they received it. If they don't answer, it's confirmed automatically.",
      label: "Record delivery",
    },
  },
  withdraw: {
    command: "withdraw",
    label: "Withdraw",
    variant: "outline",
    destructive: true,
    confirm: {
      title: "Withdraw from this errand?",
      body: "It goes back to the feed for another courier, or expires if its deadline has passed. You won't be paid for it.",
      label: "Withdraw",
    },
  },
  cancel: {
    command: "cancel",
    label: "Cancel errand",
    variant: "outline",
    destructive: true,
    confirm: {
      title: "Cancel this errand?",
      body: "Its reward is returned to your available credits. This can't be undone.",
      label: "Cancel errand",
    },
  },
  confirmReceipt: {
    command: "confirmReceipt",
    label: "Confirm receipt",
    variant: "primary",
    destructive: true,
    confirm: {
      title: "Confirm you received it?",
      body: "The reward goes to the courier. This can't be undone.",
      label: "Confirm receipt",
    },
  },
  reportNonReceipt: {
    command: "reportNonReceipt",
    label: "I didn't receive it",
    variant: "outline",
    confirm: {
      title: "Report it not received?",
      body: "An administrator will look at the errand and decide how it ends. The reward stays held until then.",
      label: "Report",
    },
  },
  reportNonDelivery: {
    command: "reportNonDelivery",
    label: "Report not delivered",
    variant: "outline",
    confirm: {
      title: "Report it not delivered?",
      body: "An administrator will look at the errand and decide how it ends. The reward stays held until then.",
      label: "Report",
    },
  },
};

function deadlineAt(order: Order, role: Role) {
  if (role === null && order.status === "OPEN") return order.acceptanceDeadlineAt;
  if (role === "REQUESTER" && order.status === "PICKED_UP") return order.nonDeliveryReportAt;
  if (role === "REQUESTER" && order.status === "DELIVERED") return order.autoConfirmAt;
  return null;
}

/** The deadline at which the actions offered to this role change, if one is coming. */
export function actionDeadline(order: Order, role: Role): number | null {
  const at = deadlineAt(order, role);
  return at ? Date.parse(at) : null;
}

function commandsFor(status: Order["status"], role: Role, deadlinePassed: boolean): Command[] {
  switch (role) {
    case null:
      return status === "OPEN" && !deadlinePassed ? ["accept"] : [];
    case "COURIER":
      if (status === "ACCEPTED") return ["pickup", "withdraw"];
      return status === "PICKED_UP" ? ["deliver"] : [];
    case "REQUESTER":
      if (status === "OPEN" || status === "ACCEPTED") return ["cancel"];
      if (status === "PICKED_UP") return deadlinePassed ? ["reportNonDelivery"] : [];
      if (status === "DELIVERED")
        return deadlinePassed ? ["confirmReceipt"] : ["confirmReceipt", "reportNonReceipt"];
      return [];
  }
}

/**
 * The next steps this role may take now, from the Order Service's transition table. The server
 * checks every one again; this only keeps the screen from offering what it would refuse.
 */
export function actionsFor(order: Order, role: Role, now: number): OrderAction[] {
  const deadline = actionDeadline(order, role);
  const passed = deadline !== null && now >= deadline;
  return commandsFor(order.status, role, passed).map((command) => ORDER_ACTIONS[command]);
}

const TOOK_EFFECT: Record<Command, (order: Order, role: Role) => boolean> = {
  accept: (_, role) => role === "COURIER",
  pickup: (order, role) => role === "COURIER" && order.status === "PICKED_UP",
  deliver: (order, role) => role === "COURIER" && order.status === "DELIVERED",
  withdraw: (_, role) => role !== "COURIER",
  cancel: (order) => order.status === "CANCELLED" || order.releaseReason === "CANCELLED",
  confirmReceipt: (order) =>
    order.status === "COMPLETION_PENDING_CREDIT" || order.status === "COMPLETED",
  reportNonReceipt: (order) => order.status === "DISPUTED",
  reportNonDelivery: (order) => order.status === "DISPUTED",
};

/**
 * Whether `order` already shows what this user's `command` does. A send whose answer was lost may
 * have gone through, so its retry is refused as stale; this tells that apart from losing a race.
 */
export function tookEffect(command: Command, order: Order, userId: string | undefined): boolean {
  return TOOK_EFFECT[command](order, roleIn(order, userId));
}

/** Codes that mean the errand moved on, so the view is re-read rather than left with a dead button. */
const STALE: Record<string, string> = {
  ORDER_NOT_OPEN: "Another courier accepted this errand first, or it closed.",
  ACCEPTANCE_DEADLINE_PASSED: "This errand's deadline passed before you accepted it.",
  SELF_ACCEPTANCE_FORBIDDEN: "This is your own errand, so you can't accept it.",
  ORDER_CHANGED: "This errand changed before your request arrived. Here's where it stands now.",
  INVALID_ORDER_STATE: "This errand changed before your request arrived. Here's where it stands now.",
  DELIVERY_PERIOD_NOT_PASSED: "It's too early to report this errand. Try again once the delivery period has passed.",
  AUTO_CONFIRMATION_PASSED: "This errand was already confirmed automatically, so it can't be reported.",
  ACTION_FORBIDDEN: "You can't do that on this errand any more.",
  NOT_FOUND: "This errand is no longer available.",
};

/** What to tell the user when a command was refused because the errand moved on, or `null`. */
export function staleMessage(err: ApiError): string | null {
  return STALE[err.code] ?? null;
}
