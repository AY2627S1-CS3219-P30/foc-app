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

/** Exact HTTP surface. Every route is read-only. The test suite inventories runtime routes. */
export const CREDIT_HTTP_SURFACE = [
  'GET /health',
  // Prometheus metrics from @foc/platform (PLT-04): counts and timings, no balances.
  'GET /metrics',
  'GET /wallets/me',
  'GET /wallets/me/ledger',
  'GET /admin/wallets/:userId',
  'GET /admin/wallets/:userId/ledger',
  'GET /internal/orders/:orderId/credit-status',
] as const;
