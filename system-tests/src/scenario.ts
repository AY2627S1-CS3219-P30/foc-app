import { randomUUID } from 'node:crypto';
import type { Stack } from './stack.js';

export const SUPPLIER = {
  supplierId: '00000000-0000-4000-8000-000000000125',
  name: 'The Deck',
  type: 'FOOD',
  building: 'COM2',
  floor: '1',
  locationDescription: 'Level 1 canteen',
};

/** Creates an order exactly as POST /orders does once its supplier is verified. */
export async function createOrder(
  stack: Stack,
  requesterId: string,
  reward: number,
): Promise<string> {
  const created = await stack.orders.createPending({
    supplierId: SUPPLIER.supplierId,
    items: [{ name: 'Kopi', quantity: 1 }],
    deliveryZone: 'COM2 Lobby',
    deliveryInstructions: 'Meet at the door',
    reward,
    requesterId,
    supplierSnapshot: SUPPLIER,
    idempotencyKey: randomUUID(),
    requestHash: randomUUID(),
    correlationId: `create-${randomUUID()}`,
  });
  return created.order.orderId;
}

const user = (id: string) => ({ kind: 'USER' as const, id, isAdmin: false });

/** Runs one participant command through the same transition path the HTTP API uses. */
export async function command(
  stack: Stack,
  orderId: string,
  action: 'RECORD_PICKUP' | 'RECORD_DELIVERY' | 'CONFIRM_RECEIPT' | 'CANCEL' | 'WITHDRAW',
  actorId: string,
) {
  return stack.orders.transition({
    orderId,
    action,
    actor: user(actorId),
    correlationId: `cmd-${randomUUID()}`,
  });
}

export async function accept(stack: Stack, orderId: string, courierId: string) {
  const order = await stack.orders.findById(orderId);
  return stack.orders.accept(orderId, courierId, order!.version, `accept-${randomUUID()}`);
}

/** OPEN → ACCEPTED → PICKED_UP → DELIVERED → COMPLETION_PENDING_CREDIT. */
export async function deliverAndConfirm(
  stack: Stack,
  orderId: string,
  requesterId: string,
  courierId: string,
) {
  await accept(stack, orderId, courierId);
  await command(stack, orderId, 'RECORD_PICKUP', courierId);
  await command(stack, orderId, 'RECORD_DELIVERY', courierId);
  await command(stack, orderId, 'CONFIRM_RECEIPT', requesterId);
}
