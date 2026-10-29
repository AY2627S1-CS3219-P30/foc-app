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
  });

  it('runs D1’s 100 concurrent users, at D1’s data volumes', () => {
    const lib = read('load/lib.js');
    expect(lib).toContain('Number(__ENV.VUS || 100)');
    const script = read('scripts-load.sh');
    expect(script).toMatch(
      /^ {2}STUDENTS=100 VUS=100 DURATION_S=60 SUPPLIERS=1000 WALLETS=10000$/m,
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

  it('meets a target at the target itself: D1 says "at most"', () => {
    const lib = read('load/lib.js');
    expect(lib).toContain('`p(95)<=${p95}`');
    expect(lib).toContain('p95 <= target');
    expect(lib).not.toMatch(/p\(95\)<\$|p95 < target/);
  });

  it('runs k6 as this machine’s user, so it can write its summary into the directory it is given', () => {
    expect(read('scripts-load.sh')).toMatch(/docker run --rm --user "\$\(id -u\):\$\(id -g\)"/);
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
  };
  const MET = {
    STUDENTS: '100',
    SUPPLIERS: '1000',
    WALLETS: '10000',
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
      const summary = { name, vus: 100, seconds: 60, thinkS: 1, endpoints };
      writeFileSync(join(out, `${name}.json`), JSON.stringify(summary));
    }
    writeFileSync(join(out, 'live.json'), JSON.stringify({ ...LIVE, ...live }));
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
