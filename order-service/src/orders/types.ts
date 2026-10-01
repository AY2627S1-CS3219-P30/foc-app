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
  createdAt: string;
  updatedAt: string;
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
