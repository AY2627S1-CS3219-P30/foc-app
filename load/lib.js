// What the load scripts share (TST-03, #166). Run them with ./scripts-load.sh, which starts a
// stack of its own, seeds it, and passes everything below in as environment variables.
import http from 'k6/http';

export const URL = {
  user: __ENV.USER_URL,
  supplier: __ENV.SUPPLIER_URL,
  credit: __ENV.CREDIT_URL,
};

/** Concurrent virtual users, how long each scenario runs, and the pause between requests. */
export const VUS = Number(__ENV.VUS || 100);
export const SECONDS = Number(__ENV.DURATION_S || 60);
export const THINK_S = Number(__ENV.THINK_S || 1);

/** The percentiles k6 keeps for every timing: p(99) is not among its defaults. */
export const SUMMARY_STATS = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];

/** One scenario of `VUS` users for `SECONDS`, starting `after` seconds into the run. */
export const scenario = (exec, after = 0) => ({
  executor: 'constant-vus',
  vus: VUS,
  duration: `${SECONDS}s`,
  startTime: `${after}s`,
  exec,
});

/** The students the script seeded: demo-load-<n>-<run>@<domain>, one password for all. */
export const STUDENTS = Number(__ENV.STUDENTS || 100);
const email = (n) => `demo-load-${n}-${__ENV.RUN}@${__ENV.EMAIL_DOMAIN}`;

export function login(n, tags) {
  return http.post(
    `${URL.user}/auth/login`,
    JSON.stringify({ email: email(n), password: __ENV.PASSWORD }),
    // Sign-in is a cookie-setting request, so the User Service checks where it came from.
    { headers: { 'content-type': 'application/json', origin: __ENV.ORIGIN }, tags },
  );
}

/** An access token for each seeded student, made before anything is measured. */
export function tokens() {
  const list = [];
  for (let n = 1; n <= STUDENTS; n++) {
    const response = login(n, { phase: 'setup' });
    if (response.status !== 200)
      throw new Error(`student ${n} could not sign in: ${response.status}`);
    list.push(response.json('accessToken'));
  }
  return list;
}

/** The student virtual user `__VU` acts as. */
export const student = () => ((__VU - 1) % STUDENTS) + 1;

export const authed = (token, endpoint) => ({
  headers: { authorization: `Bearer ${token}` },
  tags: { endpoint },
});

/**
 * Thresholds for each measured endpoint: its 95th percentile, and that no more than 1% of its
 * requests fail. The request count is listed too, so the summary carries it.
 */
export function thresholds(targets) {
  const out = {};
  for (const [endpoint, p95] of Object.entries(targets)) {
    // D1's targets are "at most": a p95 of exactly the target meets it.
    out[`http_req_duration{endpoint:${endpoint}}`] = [`p(95)<=${p95}`];
    out[`http_req_failed{endpoint:${endpoint}}`] = ['rate<0.01'];
    out[`http_reqs{endpoint:${endpoint}}`] = ['count>0'];
  }
  return out;
}

/** What the report reads: per endpoint, the target, the measured p95 and p99, requests and failures. */
export function summarise(name, targets, data) {
  const value = (metric, key) => data.metrics[metric]?.values?.[key];
  const endpoints = Object.entries(targets).map(([endpoint, target]) => {
    const duration = `http_req_duration{endpoint:${endpoint}}`;
    const failed = value(`http_req_failed{endpoint:${endpoint}}`, 'rate') ?? 0;
    const p95 = value(duration, 'p(95)');
    return {
      endpoint,
      target,
      p95,
      p99: value(duration, 'p(99)'),
      requests: value(`http_reqs{endpoint:${endpoint}}`, 'count') ?? 0,
      failedRate: failed,
      ok: p95 !== undefined && p95 <= target && failed < 0.01,
    };
  });
  const lines = endpoints.map(
    (e) =>
      `  ${e.ok ? 'PASS' : 'FAIL'}  ${e.endpoint}: p95 ${e.p95?.toFixed(1)} ms (target ${e.target}), ` +
      `${e.requests} requests, ${(e.failedRate * 100).toFixed(2)}% failed`,
  );
  return {
    [`/out/${name}.json`]: JSON.stringify({
      name,
      vus: VUS,
      seconds: SECONDS,
      thinkS: THINK_S,
      endpoints,
    }),
    stdout: `${lines.join('\n')}\n`,
  };
}
