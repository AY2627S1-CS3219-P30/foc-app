import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * TST-03 (#166) — the load test measures what D1 promised. Its figures are only comparable with the
 * targets if the targets, the load and the data volumes in the harness are D1's, so a change to any
 * of them fails here, in the Node job, rather than quietly in a report.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** `const TARGETS = { name: 500, ... }` in a k6 script, as an object. */
function targets(script: string): Record<string, number> {
  const body = read(`load/${script}.js`).match(/const TARGETS = \{([^}]*)\}/)![1]!;
  return Object.fromEntries(
    [...body.matchAll(/(\w+):\s*(\d+)/g)].map(([, name, ms]) => [name!, Number(ms)]),
  );
}

describe('the load test (TST-03)', () => {
  it('holds each endpoint to its D1 95th percentile', () => {
    expect(targets('user')).toEqual({ login: 500, profile: 300 }); // US-NFR3.1.1
    expect(targets('supplier')).toEqual({ list: 400, search: 400, lookup: 200 }); // SS-NFR2.1.1
    expect(targets('credit')).toEqual({ wallet: 300 }); // CS-NFR3.1.1
    // OS-NFR2.1.1 creating, the open list, an errand's details; OS-NFR2.1.2 a state change.
    expect(targets('order')).toEqual({ create: 700, open: 500, details: 500, command: 700 });
  });

  it('runs D1’s 100 concurrent users, at D1’s data volumes', () => {
    const lib = read('load/lib.js');
    expect(lib).toContain('Number(__ENV.VUS || 100)');
    const script = read('scripts-load.sh');
    expect(script).toMatch(
      /^ {2}STUDENTS=100 VUS=100 DURATION_S=60 SUPPLIERS=1000 WALLETS=10000 ERRANDS=10000$/m,
    );
  });

  it('measures the services over the stack’s own network, not through this machine’s ports', () => {
    // Their ports are on 127.0.0.1 (PLT-10), which a container cannot reach through the host on
    // Linux; and the edge would count 100 users from one address against its write limit.
    const script = read('scripts-load.sh');
    expect(script).toContain('--network "${COMPOSE_PROJECT_NAME}_gateway"');
    expect(script).toContain('-e USER_URL=http://user-service:3001');
    expect(script).toContain('-e SUPPLIER_URL=http://supplier-service:3002');
    expect(script).toContain('-e CREDIT_URL=http://credit-service:3004');
    expect(script).not.toContain('host.docker.internal');
  });

  it('runs on a stack of its own, with a pinned k6', () => {
    const script = read('scripts-load.sh');
    expect(script).toContain('export COMPOSE_PROJECT_NAME=foc-load');
    expect(script).toContain('export COMPOSE_FILE=compose.yaml:compose.load.yaml');
    expect(script).toMatch(/^K6='grafana\/k6:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}'$/m);
  });

  it('raises only the User Service’s sign-in and sign-up limits, and only on that stack', () => {
    const override = yaml.load(read('compose.load.yaml')) as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    expect(Object.keys(override.services)).toEqual(['user-service']);
    expect(Object.keys(override.services['user-service']!)).toEqual(['environment']);
    expect(Object.keys(override.services['user-service']!.environment).sort()).toEqual([
      'LOGIN_LIMIT_PER_EMAIL',
      'LOGIN_LIMIT_PER_IP',
      'REGISTER_LIMIT_PER_IP',
    ]);
    // The demo stack keeps the policy: compose.yaml never sets them.
    expect(read('compose.yaml')).not.toMatch(/LOGIN_LIMIT|REGISTER_LIMIT/);
  });

  it('runs its stack off production, which refuses limits raised above policy (#285)', () => {
    const script = read('scripts-load.sh');
    // Before .env is read: scripts-env.sh never overrides a variable already set.
    const pinned = script.indexOf('export NODE_ENV=development');
    expect(pinned).toBeGreaterThan(-1);
    expect(pinned).toBeLessThan(script.indexOf('. ./scripts-env.sh'));
  });

  it('meets a target at the target itself: D1 says "at most"', () => {
    const lib = read('load/lib.js');
    expect(lib).toContain('`p(95)<=${p95}`');
    expect(lib).toContain('p95 <= target');
    expect(lib).not.toMatch(/p\(95\)<\$|p95 < target/);
  });

  it('runs k6 as this machine’s user, so it can write its summary into the directory it is given', () => {
    expect(read('scripts-load.sh')).toMatch(/docker run --rm --user "\$\(id -u\):\$\(id -g\)"/);
  });

  it('waits for an errand to open once per pause, as a person would, not in a tight loop', () => {
    const order = read('load/order.js');
    expect(order).toContain('waited += THINK_S');
    expect(order).not.toMatch(/sleep\(0\.\d+\)/);
  });

  it('leaves the seeded errands out of the credit steps (CS-NFR3.1.1), as they asked for none', () => {
    const script = read('scripts-load.sh');
    // The copies belong to the copied wallets' users, `load-000001` and on; the Order Service's
    // first migration adds one more, which the Credit Service was never asked about.
    expect(script).toContain("'load-' || lpad(g::text, 6, '0') AS requester_id");
    expect(read('order-service/drizzle/0000_little_serpent_society.sql')).toContain(
      "'00000000-0000-4000-8000-000000000129'",
    );
    const steps = script.slice(script.indexOf('credit-requested.psv'));
    const reads = steps.slice(0, steps.indexOf('SQL\n', steps.indexOf('UNION ALL')));
    expect(reads).toContain(
      "WHERE requester_id NOT LIKE 'load-%' AND order_id <> '00000000-0000-4000-8000-000000000129'",
    );
    // Every kind of step is read from those errands only.
    expect(reads.match(/FROM orders/g)).toHaveLength(1);
    expect(reads.match(/FROM posted/g)).toHaveLength(3);
  });
});

/**
 * load/report.py, on k6 summaries made up here, in a Git repository of its own: what it writes,
 * whether it says the run missed a target (exit 3), and the commit it says it measured.
 */
describe('live updates under load (N1.4, #332)', () => {
  it('holds 200 streams for 40 students, five each, and times 60 accepts while the scenarios run', () => {
    const script = read('scripts-load.sh');
    expect(script).toMatch(/^ {2}LIVE_STUDENTS=40 STREAMS_EACH=5 LIVE_ERRANDS=60$/m);
    // Straight to the Order Service, as k6 reaches the services: the edge's cap of ten streams per
    // address would refuse the rest.
    expect(script).toContain('-e ORDER_URL=http://order-service:3003');
    expect(script).toMatch(/^NODE='node:22\.\d+\.\d+-alpine[\d.]*@sha256:[0-9a-f]{64}'$/m);
    expect(script).toContain('node /load/live.mjs');
  });

  it('holds an accept to reaching its requester within a second, at the 95th percentile', () => {
    expect(read('load/live.mjs')).toContain('export const TARGET_P95_MS = 1000;');
  });

  it('takes the nearest-rank percentile of what it timed', async () => {
    const { percentile } = await import(join(ROOT, 'load/live.mjs'));
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });

  it('reads the stream wherever a chunk ends, and passes each event on', async () => {
    const { eventReader } = await import(join(ROOT, 'load/live.mjs'));
    const events: { event: string; data: string }[] = [];
    const read = eventReader((event: { event: string; data: string }) => events.push(event));
    for (const chunk of [
      'event: re',
      'ady\ndata: {}\n\n: keep-alive\n\nevent: errand\ndata: {"orderId":"a"',
      ',"version":3}\n\n',
    ])
      read(chunk);
    expect(events).toEqual([
      { event: 'ready', data: '{}' },
      { event: 'errand', data: '{"orderId":"a","version":3}' },
    ]);
  });

  // The Order Service ends each stream after LIVE_STREAM_MAX_MS (5 minutes, ADR 0011) and the web
  // app reconnects. The client listens for longer than that, so without reconnecting, every accept
  // after the fifth minute had no stream to reach and counted as lost (17 of 60 on 9 Nov).
  it('opens another stream when the server ends one, as the web app does, until the run stops', async () => {
    const { hold } = await import(join(ROOT, 'load/live.mjs'));
    const bodies: string[] = [];
    let opened = 0;
    let checks = 0;
    const reconnects = await hold(
      'first',
      async () => ({ status: 200, body: `again-${++opened}` }),
      async (body: string) => void bodies.push(body),
      () => ++checks > 2,
    );
    expect(bodies).toEqual(['first', 'again-1', 'again-2']);
    expect(reconnects).toBe(2);
  });

  it('stops holding a stream when the run is over, or the service refuses or misses another', async () => {
    const { hold } = await import(join(ROOT, 'load/live.mjs'));
    const read = async () => {};
    const stillRunning = () => false;
    let connects = 0;
    const connect = async () => (connects++, { status: 200, body: 'x' });
    expect(await hold('first', connect, read, () => true)).toBe(0);
    expect(connects).toBe(0);
    expect(await hold('first', async () => ({ status: 429, body: null }), read, stillRunning)).toBe(
      0,
    );
    expect(await hold('first', () => Promise.reject(new Error('down')), read, stillRunning)).toBe(
      0,
    );
  });
});

describe('the load report', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'foc-load-report-'));
    dirs.push(dir);
    return dir;
  };

  const ENDPOINTS = {
    user: { login: 500, profile: 300 },
    supplier: { list: 400, search: 400, lookup: 200 },
    credit: { wallet: 300 },
    order: { create: 700, open: 500, details: 500, command: 700 },
  };
  const MET = {
    STUDENTS: '100',
    SUPPLIERS: '1000',
    WALLETS: '10000',
    ERRANDS: '10000',
    USER_READY: '1.8',
    SESSION: '200',
    CREDIT_READY: '1.6',
    WALLET: '200',
    STABLE: 'yes',
    OTHER_CONTAINERS: '0',
  };

  /** What load/live.mjs found, when every check is met. */
  const LIVE = {
    students: 40,
    streamsEach: 5,
    streamsOpened: 200,
    streamsReady: 200,
    sixthStream: 429,
    errands: 60,
    timed: 60,
    lost: 0,
    failures: 0,
    latencyMs: { p50: 120, p95: 400, max: 700 },
  };

  /**
   * Credit steps as scripts-load.sh reads them from the two databases: for each, the kind, and how
   * many seconds after it was requested it was recorded (`null`: never).
   */
  function writeSteps(out: string, steps: Array<[string, number | null]>) {
    const asked: string[] = [];
    const recorded: string[] = [];
    steps.forEach(([kind, after], i) => {
      const order = `order-${i}`;
      asked.push(`${order}|${kind}|${1000 + i}`);
      if (after !== null) recorded.push(`${order}|${kind}|${1000 + i + after}`);
    });
    writeFileSync(join(out, 'credit-requested.psv'), asked.join('\n'));
    writeFileSync(join(out, 'credit-recorded.psv'), recorded.join('\n'));
  }
  const each = (
    kind: string,
    count: number,
    after: number | null,
  ): Array<[string, number | null]> => Array.from({ length: count }, () => [kind, after]);
  /** 100 reservations, 50 transfers and 50 returns, each recorded 0.3 s after it was asked for. */
  const ON_TIME = [
    ...each('RESERVE', 100, 0.3),
    ...each('TRANSFER', 50, 0.3),
    ...each('RELEASE', 50, 0.3),
  ];

  /** A repository with one commit, and the k6 summaries, each endpoint at `p95` of its target. */
  function measured(missed: string[] = [], live: Record<string, unknown> = {}) {
    const repo = temp();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(join(repo, 'harness.sh'), 'echo measure\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'harness');
    const out = temp();
    for (const [name, targets] of Object.entries(ENDPOINTS)) {
      const endpoints = Object.entries(targets).map(([endpoint, target]) => ({
        endpoint,
        target,
        p95: target,
        p99: target + 1,
        requests: 100,
        failedRate: 0,
        ok: !missed.includes(endpoint),
      }));
      const summary = {
        name,
        vus: 100,
        seconds: 60,
        thinkS: 1,
        endpoints,
        ...(name === 'order' && { creditPending: { answers: 100, pending: 100 } }),
      };
      writeFileSync(join(out, `${name}.json`), JSON.stringify(summary));
    }
    writeFileSync(join(out, 'live.json'), JSON.stringify({ ...LIVE, ...live }));
    writeSteps(out, ON_TIME);
    const head = git('rev-parse', '--short', 'HEAD').toString().trim();
    return { repo, out, head };
  }

  function write(run: ReturnType<typeof measured>, env: Record<string, string> = {}) {
    const path = join(temp(), 'load-2026-10-23.md');
    const result = spawnSync('python3', [join(ROOT, 'load/report.py'), run.out, path], {
      cwd: run.repo,
      encoding: 'utf8',
      env: { ...process.env, ...MET, ...env },
    });
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // Not written: the test says so through `status`.
    }
    return { status: result.status, text, output: result.stdout + result.stderr };
  }

  it('exits 0 when every target is met', () => {
    const { status, text } = write(measured());
    expect(status).toBe(0);
    expect(text).not.toContain('**Missed**');
  });

  it('exits 3 when a response time is missed, after writing the report', () => {
    const { status, text } = write(measured(['login']));
    expect(status).toBe(3);
    expect(text).toMatch(/`login` .* \*\*Missed\*\* \|/);
  });

  it('reports the Order Service’s targets, measured on 10,000 open errands (OS-NFR2)', () => {
    const { status, text } = write(measured());
    expect(status).toBe(0);
    expect(text).toContain('10,000 open errands');
    expect(text).toMatch(/\| OS-NFR2\.1\.1 \| `create` \| ≤ 700 ms \| .* \| Met \|/);
    expect(text).toMatch(/\| OS-NFR2\.1\.1 \| `open` \| ≤ 500 ms \| .* \| Met \|/);
    expect(text).toMatch(/\| OS-NFR2\.1\.1 \| `details` \| ≤ 500 ms \| .* \| Met \|/);
    expect(text).toMatch(/\| OS-NFR2\.1\.2 \| `command` \| ≤ 700 ms \| .* \| Met \|/);
  });

  it('says every command answered before its credit result, which OS-NFR2.1.2 asks', () => {
    const { status, text } = write(measured());
    expect(status).toBe(0);
    expect(text).toMatch(/\| OS-NFR2\.1\.2 \| .*credit.* \| 100 of 100 .* \| Met \|/);
  });

  it('exits 3 when a command waited for its credit result, or none was timed', () => {
    for (const creditPending of [
      { answers: 100, pending: 99 },
      { answers: 0, pending: 0 },
    ]) {
      const run = measured();
      const order = join(run.out, 'order.json');
      writeFileSync(
        order,
        JSON.stringify({ ...JSON.parse(readFileSync(order, 'utf8')), creditPending }),
      );
      const { status, text } = write(run);
      expect(status, JSON.stringify(creditPending)).toBe(3);
      expect(text).toMatch(/\| OS-NFR2\.1\.2 \| .*credit.* \| \*\*Missed\*\* \|/);
    }
  });

  it('reports the share of credit steps recorded within 5 s, by kind (CS-NFR3.1.1)', () => {
    const { status, text } = write(measured());
    expect(status).toBe(0);
    expect(text).toContain(
      '| 100 of 100 reservations (100.0%), 50 of 50 transfers (100.0%), 50 of 50 returns (100.0%) | Met |',
    );
  });

  it('counts a step recorded 5 s after it was asked for as in time, and 99% of each kind as enough', () => {
    const run = measured();
    // 99 of 100 reservations in time, one of them at exactly 5 s; every transfer and return.
    writeSteps(run.out, [
      ...each('RESERVE', 98, 0.3),
      ['RESERVE', 5],
      ['RESERVE', 5.1],
      ...ON_TIME.filter(([kind]) => kind !== 'RESERVE'),
    ]);
    const { status, text } = write(run);
    expect(status).toBe(0);
    expect(text).toContain('| 99 of 100 reservations (99.0%), 50 of 50 transfers (100.0%), ');
  });

  it('exits 3 when any kind is below 99%, even with the total above it', () => {
    for (const [why, steps] of [
      ['97% of reservations in time', [...ON_TIME.slice(3), ...each('RESERVE', 3, 6)]],
      // 199 of 200 steps in time, but only 49 of 50 returns.
      ['98% of returns in time', [...ON_TIME.slice(0, 199), ...each('RELEASE', 1, 6)]],
      ['three never recorded', [...ON_TIME.slice(3), ...each('RESERVE', 3, null)]],
      ['no transfer measured', ON_TIME.filter(([kind]) => kind !== 'TRANSFER')],
      ['none measured', []],
    ] as const) {
      const run = measured();
      writeSteps(run.out, [...steps]);
      const { status, text } = write(run);
      expect(status, why).toBe(3);
      expect(text, why).toMatch(/\| CS-NFR3\.1\.1 \| .* \| \*\*Missed\*\* \|/);
    }
  });

  it('exits 3 when an Order Service target is missed', () => {
    const { status, text } = write(measured(['details']));
    expect(status).toBe(3);
    expect(text).toMatch(/`details` .* \*\*Missed\*\* \|/);
  });

  it('exits 3 when a restart takes longer than 60 s', () => {
    const { status, text } = write(measured(), { USER_READY: '75.2' });
    expect(status).toBe(3);
    expect(text).toContain('75.2 s');
  });

  it('reports live updates beside the response times, which were measured with the streams open', () => {
    const { status, text } = write(measured());
    expect(status).toBe(0);
    expect(text).toContain('## Live updates (N1.4)');
    expect(text).toMatch(/An accept reaches its requester's stream, p95 .* 400 ms .* \| Met \|/);
    expect(text).toContain('200 of 200');
  });

  it('exits 3 when an accept reaches its requester in a second or more, at p95', () => {
    const { status, text } = write(measured([], { latencyMs: { p50: 600, p95: 1000, max: 1400 } }));
    expect(status).toBe(3);
    expect(text).toMatch(/An accept reaches its requester's stream, p95 .* \*\*Missed\*\* \|/);
  });

  it('exits 3 when a nudge was lost, a stream never opened, or a sixth stream was let in', () => {
    for (const live of [
      { lost: 1 },
      { streamsReady: 199 },
      { sixthStream: 200 },
      { failures: 2 },
    ]) {
      const { status, text } = write(measured([], live));
      expect(status, JSON.stringify(live)).toBe(3);
      expect(text, JSON.stringify(live)).toContain('**Missed**');
    }
  });

  it('names the commit measured, and marks it dirty when the measured files had changes', () => {
    const run = measured();
    expect(write(run).text).toContain(`from commit \`${run.head}\``);
    // A local .gitignore line cannot change a figure, so it does not count.
    writeFileSync(join(run.repo, '.gitignore'), 'node_modules/\n.agents/\n');
    expect(write(run).text).toContain(`from commit \`${run.head}\``);
    writeFileSync(join(run.repo, 'harness.sh'), 'echo measure faster\n');
    expect(write(run).text).toContain(`from commit \`${run.head}-dirty\``);
  });
});
