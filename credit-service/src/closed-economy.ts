import { EVENTS } from '@foc/platform';
import { RESERVATION_QUEUE } from './reservation-consumer.js';
import { COMPLETION_QUEUE, RELEASE_QUEUE } from './terminal-consumers.js';
import { WALLET_QUEUE } from './wallet-provisioning.js';

/** The complete deployed set of inputs allowed to create an economic effect. */
export const CREDIT_ECONOMIC_SUBSCRIPTIONS = [
  {
    queue: WALLET_QUEUE,
    routingKeys: [EVENTS.USER_ACTIVATED],
    expectedProducer: 'user-service',
    effect: 'ISSUE',
  },
  {
    queue: RESERVATION_QUEUE,
    routingKeys: [EVENTS.CREDIT_RESERVATION_REQUESTED],
    expectedProducer: 'order-service',
    effect: 'RESERVE',
  },
  {
    queue: COMPLETION_QUEUE,
    routingKeys: [EVENTS.ORDER_COMPLETION_REQUESTED],
    expectedProducer: 'order-service',
    effect: 'TRANSFER',
  },
  {
    queue: RELEASE_QUEUE,
    routingKeys: [EVENTS.CREDIT_RELEASE_REQUESTED],
    expectedProducer: 'order-service',
    effect: 'RELEASE',
  },
] as const;

/**
 * Exact HTTP surface. The test suite inventories runtime routes. Neither write moves credit:
 * a ledger audit appends findings only; the redrive (PLT-05) sends an input, byte for byte, back to the
 * queue above that it failed on, so a balance still changes only through those four subscriptions,
 * their inbox and their checks.
 */
export const CREDIT_HTTP_SURFACE = [
  'GET /health',
  // Prometheus metrics from @foc/platform (PLT-04): counts and timings, no balances.
  'GET /metrics',
  'GET /wallets/me',
  'GET /wallets/me/ledger',
  'GET /admin/wallets/:userId',
  'GET /admin/wallets/:userId/ledger',
  'GET /internal/orders/:orderId/credit-status',
  // PLT-05 operator views: no balances.
  'GET /admin/orders/:orderId/credit',
  'GET /admin/credit-alerts',
  // ADM-04: admins who read many wallets in an hour.
  'GET /admin/activity-alerts',
  'GET /admin/dead-letters',
  'GET /admin/dead-letters/:id',
  'POST /admin/dead-letters/:id/redrive',
  'GET /admin/ledger-audits/latest',
  'POST /admin/ledger-audits/run',
] as const;

/** Writes only the dead letter's redrive stamp. */
export const CREDIT_REDRIVE_ROUTE = 'POST /admin/dead-letters/:id/redrive';
/** Appends an audit result and never changes monetary rows. */
export const CREDIT_AUDIT_ROUTE = 'POST /admin/ledger-audits/run';
