// CS-NFR3.1.1 (first half): with 10,000 wallets and 100 concurrent users, p95 at most 300 ms
// for a wallet lookup. Each virtual user reads its own student's wallet.
import { check, sleep } from 'k6';
import http from 'k6/http';
import {
  authed,
  scenario,
  student,
  summarise,
  SUMMARY_STATS,
  THINK_S,
  thresholds,
  tokens,
  URL,
} from './lib.js';

const TARGETS = { wallet: 300 };

export const options = {
  scenarios: { wallets: scenario('balance') },
  thresholds: thresholds(TARGETS),
  summaryTrendStats: SUMMARY_STATS,
};

export const setup = () => ({ tokens: tokens() });

export function balance(data) {
  const response = http.get(
    `${URL.credit}/wallets/me`,
    authed(data.tokens[student() - 1], 'wallet'),
  );
  check(response, { 'read the wallet': (r) => r.status === 200 });
  sleep(THINK_S);
}

export const handleSummary = (data) => summarise('credit', TARGETS, data);
