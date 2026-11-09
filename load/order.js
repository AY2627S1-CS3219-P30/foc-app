// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-11-04 to 2026-11-09
// Scope: Joint work by Zhang Yuan and Jonus Ho (#181). Generated the implementation of the Order
//   Service scenarios: posting errands, cancelling half and carrying the rest through delivery to
//   the requester's confirmation, each command timed against OS-NFR2.1.1 and OS-NFR2.1.2.
// Author review: Zhang Yuan validated that the implementation was correct. Jonus Ho then reviewed
//   it and ran the final load test on it, where every target was met.

// OS-NFR2.1.1: with 10,000 errands and 100 concurrent users, p95 at most 700 ms for creating a
// request and 500 ms for the open list or an errand's details. OS-NFR2.1.2: a state-changing
// command returns its result within 700 ms, without waiting for a credit result.
//
// Two scenarios, one after the other. In `post` each virtual user posts an errand for its student
// and waits until the credit is reserved and the errand is open. It cancels every other errand,
// which starts a credit return. The rest it carries as the next student, the courier: accept,
// pickup, delivery, then its own student confirms receipt, which starts a transfer. Every command
// is timed, and the answers that start a credit step must already say that step is pending, so
// they did not wait for the Credit Service. In `browse` each reads the open list as the feed does,
// then opens one of the seeded errands. How long each credit step took to be recorded
// (CS-NFR3.1.1) is read from the databases afterwards, by ./scripts-load.sh.
import { check, sleep } from 'k6';
import http from 'k6/http';
import { Rate } from 'k6/metrics';
import {
  authed,
  scenario,
  SECONDS,
  student,
  summarise,
  STUDENTS,
  SUMMARY_STATS,
  THINK_S,
  thresholds,
  tokens,
  URL,
} from './lib.js';

const TARGETS = { create: 700, open: 500, details: 500, command: 700 };

/** How long a virtual user waits for its errand to open, checking once per pause. */
const OPEN_WAIT_S = 10;

/** Of the cancels and confirms answered, the share whose answer said the credit step was pending. */
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

/** One command on an errand, timed as `command`. Returns the answer when it was accepted. */
function act(token, orderId, action, expectedVersion) {
  const answer = http.post(
    `${URL.order}/orders/${orderId}/${action}`,
    JSON.stringify({ expectedVersion }),
    send(token, 'command'),
  );
  // An accept answers 201, as the contract says; every other command 200.
  const done = answer.status === (action === 'accept' ? 201 : 200);
  check(answer, { [action]: () => done });
  return done ? answer : null;
}

/**
 * Every other errand is cancelled, which starts a credit return. The rest are carried by the
 * courier and confirmed by the requester, which starts a transfer. Either answer must already say
 * its credit step is pending.
 */
function settle(token, courier, orderId, version) {
  if (__ITER % 2 === 0) {
    const cancelled = act(token, orderId, 'cancel', version);
    if (cancelled) pending.add(cancelled.json('status') === 'RELEASE_PENDING_CREDIT');
    return;
  }
  let answer = act(courier, orderId, 'accept', version);
  for (const action of ['pickup', 'deliver']) {
    if (!answer) return;
    sleep(THINK_S);
    answer = act(courier, orderId, action, answer.json('version'));
  }
  if (!answer) return;
  sleep(THINK_S);
  const confirmed = act(token, orderId, 'confirm-receipt', answer.json('version'));
  if (confirmed) pending.add(confirmed.json('status') === 'COMPLETION_PENDING_CREDIT');
}

export function post(data) {
  const token = data.tokens[student() - 1];
  // Student n's courier is student n + 1, and the last student's is the first.
  const courier = data.tokens[student() % STUDENTS];
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
    // Untimed, and checked once per pause as a person would: how long the Credit Service takes
    // to reserve is not the Order Service's answer.
    let version = null;
    for (let waited = 0; waited < OPEN_WAIT_S && version === null; waited += THINK_S) {
      sleep(THINK_S);
      const read = http.get(`${URL.order}/orders/${orderId}`, authed(token, 'wait'));
      if (read.json('status') === 'OPEN') version = read.json('version');
    }
    if (version !== null) settle(token, courier, orderId, version);
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
