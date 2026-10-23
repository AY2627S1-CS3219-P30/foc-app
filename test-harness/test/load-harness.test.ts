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

  /** A repository with one commit, and the k6 summaries, each endpoint at `p95` of its target. */
  function measured(missed: string[] = []) {
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
