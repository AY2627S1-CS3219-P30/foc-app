// SS-NFR2.1.1: with 1,000 suppliers and 100 concurrent users, p95 at most 400 ms for list or
// search and 200 ms for lookup by identifier. Each virtual user lists a page, searches, and opens
// one supplier, in turn.
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

const TARGETS = { list: 400, search: 400, lookup: 200 };
const PAGE_SIZE = 20;

export const options = {
  scenarios: { suppliers: scenario('browse') },
  thresholds: thresholds(TARGETS),
  summaryTrendStats: SUMMARY_STATS,
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function setup() {
  const list = tokens();
  // Every supplier's id, and a word from each name to search for.
  const ids = [];
  const words = new Set();
  for (let page = 1; ; page++) {
    const body = http
      .get(`${URL.supplier}/suppliers?page=${page}&pageSize=100`, authed(list[0], 'setup'))
      .json();
    for (const item of body.items) {
      ids.push(item.supplierId);
      words.add(item.name.split(/\s+/)[0]);
    }
    if (page * 100 >= body.total) break;
  }
  return { tokens: list, ids, words: [...words], pages: Math.ceil(ids.length / PAGE_SIZE) };
}

export function browse(data) {
  const params = (endpoint) => authed(data.tokens[student() - 1], endpoint);
  const page = 1 + Math.floor(Math.random() * data.pages);
  const listed = http.get(
    `${URL.supplier}/suppliers?page=${page}&pageSize=${PAGE_SIZE}&sort=name`,
    params('list'),
  );
  check(listed, { listed: (r) => r.status === 200 });
  const q = encodeURIComponent(pick(data.words));
  const found = http.get(
    `${URL.supplier}/suppliers?q=${q}&pageSize=${PAGE_SIZE}`,
    params('search'),
  );
  check(found, { searched: (r) => r.status === 200 });
  const opened = http.get(`${URL.supplier}/suppliers/${pick(data.ids)}`, params('lookup'));
  check(opened, { 'opened one': (r) => r.status === 200 });
  sleep(THINK_S);
}

export const handleSummary = (data) => summarise('supplier', TARGETS, data);
