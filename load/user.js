// US-NFR3.1.1: with 100 concurrent users and seeded data, p95 at most 500 ms for login and
// 300 ms for profile lookup. One scenario each, one after the other, so neither skews the other.
import { check, sleep } from 'k6';
import http from 'k6/http';
import {
  authed,
  login,
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

const TARGETS = { login: 500, profile: 300 };

export const options = {
  scenarios: { login: scenario('signIn'), profile: scenario('profile', SECONDS + 5) },
  thresholds: thresholds(TARGETS),
  summaryTrendStats: SUMMARY_STATS,
};

export const setup = () => ({ tokens: tokens() });

export function signIn() {
  const response = login(student(), { endpoint: 'login' });
  check(response, { 'signed in': (r) => r.status === 200 });
  sleep(THINK_S);
}

export function profile(data) {
  const response = http.get(`${URL.user}/users/me`, authed(data.tokens[student() - 1], 'profile'));
  check(response, { 'read the profile': (r) => r.status === 200 });
  sleep(THINK_S);
}

export const handleSummary = (data) => summarise('user', TARGETS, data);
