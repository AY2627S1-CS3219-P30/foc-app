import { REWARD_MAX, REWARD_MIN } from "./composer";
import type { Order, OrderStatus } from "./order-api";

/**
 * Labels are the ones order-service/README.md's state table gives the web app. `slow` is shown
 * once a state that waits on the Credit Service has lasted longer than usual.
 */
export const ORDER_STATUS: Record<
  OrderStatus,
  { label: string; explanation: string; slow?: string }
> = {
  PENDING_CREDIT: {
    label: "Waiting for credits",
    explanation:
      "Your request is in. The Credit Service is reserving its reward, and couriers will see it once that's done.",
    slow:
      "This is taking longer than usual. Your request is saved and opens as soon as the credits are reserved, so you can leave this page and come back.",
  },
  OPEN: {
    label: "Open",
    explanation: "The reward is reserved. The request is waiting for a courier to accept it.",
  },
  ACCEPTED: {
    label: "Accepted",
    explanation: "A courier has accepted the errand and is on the way to pick it up.",
  },
  PICKED_UP: {
    label: "In transit",
    explanation: "The courier has collected the items and is on the way to deliver them.",
  },
  DELIVERED: {
    label: "Delivered, confirm receipt",
    explanation: "The courier has recorded delivery. Confirm you received it, or report that you didn't.",
  },
  DISPUTED: {
    label: "With an administrator",
    explanation: "The errand was referred to an administrator, who will decide how it ends.",
  },
  COMPLETION_PENDING_CREDIT: {
    label: "Paying the courier",
    explanation: "Delivery is accepted. The Credit Service is transferring the reward to the courier.",
    slow:
      "This is taking longer than usual. Delivery is accepted and the courier is paid as soon as the transfer goes through, so you can leave this page and come back.",
  },
  RELEASE_PENDING_CREDIT: {
    label: "Returning credits",
    explanation: "The errand is ending without payment. The Credit Service is returning the reward to you.",
    slow:
      "This is taking longer than usual. Your credits are safe and come back to you as soon as the release goes through, so you can leave this page and come back.",
  },
  REJECTED: {
    label: "Not placed",
    explanation: "The reward could not be reserved, so the request was not posted and no credits are held.",
  },
  COMPLETED: {
    label: "Complete",
    explanation: "The reward has been transferred to the courier.",
  },
  CANCELLED: {
    label: "Cancelled",
    explanation: "The errand was cancelled and the reward has been returned to you.",
  },
  EXPIRED: {
    label: "Expired",
    explanation: "No courier kept the errand before its deadline, so the reward has been returned to you.",
  },
};

const FINAL = new Set<OrderStatus>(["REJECTED", "COMPLETED", "CANCELLED", "EXPIRED"]);

/** No transition leaves these states, so there is nothing more to read. */
export const isFinal = (status: OrderStatus) => FINAL.has(status);

/** The Credit Service is moving credits; the next state follows as soon as it answers. */
export const waitsOnCredit = (status: OrderStatus) => status.endsWith("PENDING_CREDIT");

/** What to do about a `REJECTED` order, for each reason the Credit Service gives. */
export function rejectionMessage(order: Pick<Order, "reward" | "rejection">): string {
  const available = order.rejection?.available;
  switch (order.rejection?.reason) {
    case "INSUFFICIENT_CREDITS": {
      const had =
        available === undefined ? "You didn't have enough credits" : `You had ${available} available`;
      const next = available
        ? `Post it again with a reward of ${available} or less, or earn more by delivering errands.`
        : "Delivering errands as a courier is how you earn credits.";
      return `${had} for a ${order.reward}-credit reward. ${next}`;
    }
    case "AMOUNT_OUT_OF_RANGE":
      return `The reward must be between ${REWARD_MIN} and ${REWARD_MAX} credits. Post the request again with a reward in that range.`;
    case "CONFLICTING_REQUEST":
      return "The Credit Service already held a different reservation for this errand. Post the request again.";
    default:
      return "The Credit Service couldn't reserve the reward. Post the request again.";
  }
}
