export type RequestStatus =
  | "open"
  | "accepted"
  | "in_transit"
  | "complete"
  | "cancelled";

export type ErrandRequest = {
  id: string;
  title: string;
  supplier: string;
  dropoff: string;
  description: string;
  credits: number;
  status: RequestStatus;
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

export type Supplier = {
  id: string;
  name: string;
  location: string;
  category: string;
  distance: string;
};

export const CURRENT_USER = { id: "me", name: "You" };
