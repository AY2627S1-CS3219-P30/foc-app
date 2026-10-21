import type { OrderStatus } from "./order-api";

export type ErrandRequest = {
  id: string;
  title: string;
  supplier: string;
  dropoff: string;
  description: string;
  credits: number;
  status: OrderStatus;
  requesterId: string;
  requesterName: string;
  courierId?: string;
  courierName?: string;
  expiryLabel: string;
  createdAt: number;
};

export type LedgerType = "earned" | "spent" | "reserved" | "released";

export type LedgerEntry = {
  id: string;
  type: LedgerType;
  label: string;
  detail: string;
  amount: number;
  createdAt: number;
};

export const CURRENT_USER = { id: "me", name: "You" };
