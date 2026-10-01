export const INITIAL_CREDIT_ALLOCATION = 10;

export type TransactionType = 'ISSUE' | 'RESERVE' | 'RELEASE' | 'TRANSFER';
export type ReservationRejection =
  'INSUFFICIENT_CREDITS' | 'AMOUNT_OUT_OF_RANGE' | 'CONFLICTING_REQUEST';

export interface WalletView {
  userId: string;
  available: number;
  reserved: number;
  total: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerItem {
  transactionId: string;
  type: TransactionType;
  amount: number;
  orderId: string | null;
  occurredAt: string;
  resultingAvailable: number;
  resultingReserved: number;
  resultingTotal: number;
}

export interface LedgerPage {
  items: LedgerItem[];
  nextCursor: string | null;
}

export interface ReservationInput {
  orderId: string;
  requesterId: string;
  amount: number;
  correlationId: string;
  causationId: string;
}

export type ReservationOutcome =
  | { status: 'RESERVED'; transactionId: string }
  | { status: 'REJECTED'; reason: ReservationRejection; available?: number };

export type ReservationBoundary =
  | 'operation-claimed'
  | 'wallet-updated'
  | 'transaction-written'
  | 'ledger-written'
  | 'operation-finalized'
  | 'outbox-written';
