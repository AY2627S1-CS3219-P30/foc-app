import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

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
});
