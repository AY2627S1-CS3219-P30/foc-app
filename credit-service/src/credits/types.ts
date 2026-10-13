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

export interface TransactionReference {
  transactionId: string;
  type: 'RESERVE' | 'RELEASE' | 'TRANSFER';
  occurredAt: string;
}

export interface OrderCreditStatus {
  orderId: string;
  status: 'NONE' | 'RESERVED' | 'RELEASED' | 'TRANSFERRED';
  detail: 'UNKNOWN' | 'IN_FLIGHT' | 'REJECTED' | null;
  rejectionReason: ReservationRejection | null;
  recordedAt: string | null;
  reservation: TransactionReference | null;
  terminal: TransactionReference | null;
}

export interface ReservationInput {
  orderId: string;
  requesterId: string;
  amount: number;
  correlationId: string;
  causationId: string;
}

export interface ResultingBalance {
  available: number;
  reserved: number;
  total: number;
}

interface TerminalInput {
  orderId: string;
  requesterId: string;
  amount: number;
  correlationId: string;
  causationId: string;
}

export interface TransferInput extends TerminalInput {
  courierId: string;
}

export type ReleaseInput = TerminalInput;

export interface TransferResult {
  orderId: string;
  requesterId: string;
  courierId: string;
  amount: number;
  transactionId: string;
  requesterBalance: ResultingBalance;
  courierBalance: ResultingBalance;
}

export interface ReleaseResult {
  orderId: string;
  requesterId: string;
  amount: number;
  transactionId: string;
  requesterBalance: ResultingBalance;
}

export type TerminalRejection =
  | 'CONFLICTING_REQUEST'
  | 'INVALID_PARTICIPANTS'
  | 'RESERVATION_NOT_ACTIVE'
  | 'TERMINAL_OPERATION_CONFLICT';

export type TransferOutcome =
  | { status: 'TRANSFERRED'; result: TransferResult }
  | { status: 'REJECTED'; reason: TerminalRejection };

export type ReleaseOutcome =
  { status: 'RELEASED'; result: ReleaseResult } | { status: 'REJECTED'; reason: TerminalRejection };

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

export type TerminalBoundary =
  | 'reservation-locked'
  | 'operation-claimed'
  | 'requester-wallet-updated'
  | 'courier-wallet-updated'
  | 'transaction-written'
  | 'ledger-written'
  | 'operation-finalized'
  | 'outbox-written';
