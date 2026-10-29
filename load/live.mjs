/**
 * N1.4 (#332): live updates under load. Run by ./scripts-load.sh beside the k6 scenarios, on the
 * stack's own network, straight to the Order Service: the edge's cap of ten streams per address
 * would refuse the rest, as every client here is one machine.
 *
 *   LIVE_STUDENTS students (the harness's seeded demo-load-<n>) each hold STREAMS_EACH streams, the
 *   Order Service's own cap per user, for the whole run. A sixth for one of them must be refused.
 *   LIVE_ERRANDS errands are posted at a steady rate over LIVE_SECONDS, each by a student of the
 *   first half and accepted by one of the second; each accept is timed from its answer to the
 *   `errand` nudge on the requester's stream.
 *
 * Writes /out/live.json, which load/report.py reads. Node 22, nothing to install.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** An accept must reach its requester's stream within this, at the 95th percentile. */
export const TARGET_P95_MS = 1000;
/** A nudge that has not come this long after its accept's answer is counted lost. */
const LOST_AFTER_MS = 5_000;
/** A stream that has not said `ready` this long after opening does not count as held. */
const READY_WITHIN_MS = 10_000;

/** The nearest-rank percentile of `values`, or `null` when there are none. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * Splits a `text/event-stream` into `{ event, data }`, wherever a chunk ends. The Order Service
 * writes LF line ends; a comment, such as the keep-alive, is skipped. Returns what to feed.
 */
export function eventReader(onEvent) {
  let pending = '';
  return (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n\n')) >= 0) {
      const frame = pending.slice(0, end);
      pending = pending.slice(end + 2);
      let event = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (data.length > 0) onEvent({ event, data: data.join('\n') });
    }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const env = process.env;
  const students = Number(env.LIVE_STUDENTS);
  const streamsEach = Number(env.STREAMS_EACH);
  const errands = Number(env.LIVE_ERRANDS);
  const seconds = Number(env.LIVE_SECONDS);
  const result = {
    students,
    streamsEach,
    streamsOpened: 0,
    streamsReady: 0,
    sixthStream: null,
    errands: 0,
    timed: 0,
    lost: 0,
    failures: 0,
    latencyMs: { p50: null, p95: null, max: null },
  };

  const json = { 'content-type': 'application/json' };
  const bearer = (token) => ({ authorization: `Bearer ${token}` });
  const tokens = [];
  for (let n = 1; n <= students; n++) {
    const email = `demo-load-${n}-${env.RUN}@${env.EMAIL_DOMAIN}`;
    const answer = await fetch(`${env.USER_URL}/auth/login`, {
      method: 'POST',
      headers: { ...json, origin: env.ORIGIN },
      body: JSON.stringify({ email, password: env.PASSWORD }),
    });
    if (answer.status !== 200) throw new Error(`student ${n} could not sign in: ${answer.status}`);
    tokens.push((await answer.json()).accessToken);
  }

  // Who is waiting for which errand's nudge, by student: index → set of callbacks.
  const waiting = new Map();
  const controllers = [];
  async function openStream(student) {
    const controller = new AbortController();
    controllers.push(controller);
    const answer = await fetch(`${env.ORDER_URL}/live`, {
      headers: bearer(tokens[student]),
      signal: controller.signal,
    });
    if (answer.status !== 200) {
      controller.abort();
      return { status: answer.status, ready: Promise.resolve(false) };
    }
    let saidReady;
    const ready = new Promise((resolve) => {
      saidReady = resolve;
      setTimeout(() => resolve(false), READY_WITHIN_MS).unref();
    });
    const feed = eventReader(({ event, data }) => {
      if (event === 'ready') saidReady(true);
      if (event !== 'errand') return;
      const nudge = JSON.parse(data);
      for (const notify of waiting.get(student) ?? []) notify(nudge, performance.now());
    });
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of answer.body) feed(decoder.decode(chunk, { stream: true }));
      } catch {
        // Aborted at the end of the run.
      }
    })();
    return { status: answer.status, ready };
  }

  const opened = [];
  for (let student = 0; student < students; student++)
    for (let i = 0; i < streamsEach; i++) opened.push(await openStream(student));
  result.streamsOpened = opened.filter((s) => s.status === 200).length;
  result.streamsReady = (await Promise.all(opened.map((s) => s.ready))).filter(Boolean).length;
  result.sixthStream = (await openStream(0)).status;

  const suppliers = await fetch(`${env.SUPPLIER_URL}/suppliers?pageSize=1`, {
    headers: bearer(tokens[0]),
  });
  const supplierId = (await suppliers.json()).items?.[0]?.supplierId;
  if (!supplierId) throw new Error(`no supplier to post an errand for: ${suppliers.status}`);

  const half = Math.floor(students / 2);
  const latencies = [];
  async function errand(k) {
    const requester = k % half;
    const courier = half + (k % half);
    const created = await fetch(`${env.ORDER_URL}/orders`, {
      method: 'POST',
      headers: { ...json, ...bearer(tokens[requester]), 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        supplierId,
        items: [{ name: `Live load ${k}`, quantity: 1 }],
        deliveryZone: 'COM2 Lobby',
        deliveryInstructions: 'Left at the counter.',
        reward: 1,
      }),
    });
    if (created.status !== 201) return void result.failures++;
    result.errands++;
    const { orderId } = await created.json();
    let version = null;
    for (let i = 0; i < 150 && version === null; i++) {
      const read = await (
        await fetch(`${env.ORDER_URL}/orders/${orderId}`, { headers: bearer(tokens[requester]) })
      ).json();
      if (read.status === 'OPEN') version = read.version;
      else await sleep(200);
    }
    if (version === null) return void result.failures++;

    // Listened for before accepting: the nudge can come before the accept's own answer does.
    let heard;
    const nudged = new Promise((resolve) => (heard = resolve));
    const listener = (nudge, at) => {
      if (nudge.orderId === orderId && (nudge.version ?? Infinity) > version) heard(at);
    };
    const own = waiting.get(requester) ?? new Set();
    own.add(listener);
    waiting.set(requester, own);
    try {
      const accepted = await fetch(`${env.ORDER_URL}/orders/${orderId}/accept`, {
        method: 'POST',
        headers: { ...json, ...bearer(tokens[courier]) },
        body: JSON.stringify({ expectedVersion: version }),
      });
      const answeredAt = performance.now();
      if (accepted.status !== 201) return void result.failures++;
      const at = await Promise.race([nudged, sleep(LOST_AFTER_MS).then(() => null)]);
      if (at === null) result.lost++;
      else {
        result.timed++;
        latencies.push(Math.max(0, at - answeredAt));
      }
    } finally {
      own.delete(listener);
    }
  }

  const every = (seconds * 1000) / errands;
  const runs = [];
  for (let k = 0; k < errands; k++) {
    runs.push(errand(k).catch(() => void result.failures++));
    await sleep(every);
  }
  await Promise.all(runs);
  for (const controller of controllers) controller.abort();

  const round = (ms) => (ms === null ? null : Math.round(ms));
  result.latencyMs = {
    p50: round(percentile(latencies, 50)),
    p95: round(percentile(latencies, 95)),
    max: round(latencies.length ? Math.max(...latencies) : null),
  };
  writeFileSync('/out/live.json', JSON.stringify(result, null, 2));
  console.log(
    `live: ${result.streamsReady} of ${students * streamsEach} streams held; ${result.timed} accepts timed, ` +
      `p95 ${result.latencyMs.p95} ms; ${result.lost} lost; sixth stream ${result.sixthStream}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`live: ${err.message}`);
    process.exit(1);
  });
}
