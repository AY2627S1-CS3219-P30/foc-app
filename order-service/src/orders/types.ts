export const ORDER_STATUSES = [
  'PENDING_CREDIT',
  'OPEN',
  'ACCEPTED',
  'PICKED_UP',
  'DELIVERED',
  'DISPUTED',
  'COMPLETION_PENDING_CREDIT',
  'RELEASE_PENDING_CREDIT',
  'REJECTED',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_ORDER_STATUSES = ['REJECTED', 'COMPLETED', 'CANCELLED', 'EXPIRED'] as const;

export interface OrderItem {
  name: string;
  quantity: number;
  note?: string;
}

export interface SupplierSnapshot {
  supplierId: string;
  name: string;
  type: string;
  building: string;
  floor: string;
  locationDescription: string;
}

export interface OrderRow {
  orderId: string;
  requesterId: string;
  courierId: string | null;
  referredAdminId: string | null;
  supplierSnapshot: SupplierSnapshot;
  items: OrderItem[];
  deliveryZone: string;
  deliveryInstructions: string;
  reward: number;
  status: OrderStatus;
  releaseReason: 'CANCELLED' | 'EXPIRED' | null;
  rejectionReason: string | null;
  availableAtRejection: number | null;
  version: number;
  acceptanceDeadlineAt: string | null;
  acceptedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  completionRequestedAt: string | null;
  completedAt: string | null;
  creditTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Immutable record of a completed errand (OS-FR5.1.2). */
export interface OrderReceipt {
  orderId: string;
  requesterId: string;
  courierId: string;
  supplier: SupplierSnapshot;
  reward: number;
  creditTransactionId: string;
  timestamps: {
    createdAt: string;
    acceptedAt: string;
    pickedUpAt: string;
    deliveredAt: string;
    completionRequestedAt: string;
    completedAt: string;
  };
}

export interface OrderView {
  orderId: string;
  supplier: SupplierSnapshot;
  items: OrderItem[];
  deliveryZone: string;
  reward: number;
  status: OrderStatus;
  version: number;
  acceptanceDeadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
  requesterId?: string;
  courierId?: string;
  deliveryInstructions?: string;
  rejection?: { reason: string; available?: number };
}

export interface OpenOrderSummary {
  orderId: string;
  supplier: SupplierSnapshot;
  itemSummary: Array<Pick<OrderItem, 'name' | 'quantity'>>;
  deliveryZone: string;
  reward: number;
  status: 'OPEN';
  version: number;
  acceptanceDeadlineAt: string;
  timeRemainingSeconds: number;
  createdAt: string;
}
