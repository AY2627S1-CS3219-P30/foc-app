// OS-NFR2.1.1: with 10,000 errands and 100 concurrent users, p95 at most 700 ms for creating a
// request and 500 ms for the open list or an errand's details. OS-NFR2.1.2: a state-changing
// command returns its result within 700 ms, without waiting for a credit result.
//
// Two scenarios, one after the other. In `post` each virtual user posts an errand for its student,
// waits until the credit is reserved and the errand is open, then cancels it. The cancel is the
// command timed: it starts a credit step (the return), and its answer must already say that step
// is pending, so it did not wait for the Credit Service. In `browse` each reads the open list as
// the feed does, then opens one of the seeded errands.
import { check, sleep } from 'k6';
import http from 'k6/http';
import { Rate } from 'k6/metrics';
import {
  authed,
  scenario,
  SECONDS,
  student,
  summarise,
  SUMMARY_STATS,
  THINK_S,
  thresholds,
  tokens,
  URL,
} from './lib.js';

const TARGETS = { create: 700, open: 500, details: 500, command: 700 };

/** Of the cancels answered, the share whose answer said the credit return was still pending. */
const pending = new Rate('credit_pending');

export const options = {
  scenarios: { post: scenario('post'), browse: scenario('browse', SECONDS + 5) },
  thresholds: thresholds(TARGETS),
  summaryTrendStats: SUMMARY_STATS,
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function setup() {
  const list = tokens();
  const supplierId = http
    .get(`${URL.supplier}/suppliers?pageSize=1`, authed(list[0], 'setup'))
    .json('items.0.supplierId');
  // Every seeded errand's id, through the open list a page at a time.
  const ids = [];
  let cursor = '';
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const page = http.get(`${URL.order}/orders${query}`, authed(list[0], 'setup'));
    for (const order of page.json()) ids.push(order.orderId);
    cursor = page.headers['Next-Cursor'];
  } while (cursor);
  return { tokens: list, supplierId, ids };
}

const send = (token, endpoint, extra = {}) => ({
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
  tags: { endpoint },
});

export function post(data) {
  const token = data.tokens[student() - 1];
  const created = http.post(
    `${URL.order}/orders`,
    JSON.stringify({
      supplierId: data.supplierId,
      items: [{ name: 'Chicken rice', quantity: 1 }],
      deliveryZone: 'COM2 Lobby',
      deliveryInstructions: 'Meet at the security desk',
      reward: 1,
    }),
    send(token, 'create', { 'idempotency-key': `load-${__ENV.RUN}-${__VU}-${__ITER}` }),
  );
  check(created, { posted: (r) => r.status === 201 });
  if (created.status === 201) {
    const orderId = created.json('orderId');
    // Untimed: how long the Credit Service takes to reserve is not the Order Service's answer.
    let version = null;
    for (let i = 0; i < 50 && version === null; i++) {
      sleep(0.1);
      const read = http.get(`${URL.order}/orders/${orderId}`, authed(token, 'wait'));
      if (read.json('status') === 'OPEN') version = read.json('version');
    }
    if (version !== null) {
      const cancelled = http.post(
        `${URL.order}/orders/${orderId}/cancel`,
        JSON.stringify({ expectedVersion: version }),
        send(token, 'command'),
      );
      check(cancelled, { cancelled: (r) => r.status === 200 });
      if (cancelled.status === 200) {
        pending.add(cancelled.json('status') === 'RELEASE_PENDING_CREDIT');
      }
    }
  }
  sleep(THINK_S);
}

export function browse(data) {
  const params = (endpoint) => authed(data.tokens[student() - 1], endpoint);
  const listed = http.get(`${URL.order}/orders`, params('open'));
  check(listed, { listed: (r) => r.status === 200 });
  const opened = http.get(`${URL.order}/orders/${pick(data.ids)}`, params('details'));
  check(opened, { 'opened one': (r) => r.status === 200 });
  sleep(THINK_S);
}

export function handleSummary(data) {
  const { passes = 0, fails = 0 } = data.metrics.credit_pending?.values ?? {};
  return summarise('order', TARGETS, data, {
    creditPending: { answers: passes + fails, pending: passes },
  });
}
