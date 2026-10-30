import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * PLT-13 (#289) — the stack is ready only when every page can work. The edge answers
 * `GET /edge/ready` from `edge/readiness.js`, which nginx runs (njs): 200 while the web app and
 * all five services answer their health checks, 503 naming each that does not. The handler is
 * run here against stand-in upstreams; `scripts-smoke.sh` stops a real service and watches it.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

interface ComposeService {
  depends_on?: Record<string, { condition: string }>;
  volumes?: string[];
  healthcheck?: { test: string[]; interval?: string; retries?: number; start_period?: string };
}
const services = (yaml.load(read('compose.yaml')) as { services: Record<string, ComposeService> })
  .services;
const nginx = read('edge/nginx.conf');

const UPSTREAMS = {
  'web-app': 'http://web-app:3000/',
  'user-service': 'http://user-service:3001/health',
  'supplier-service': 'http://supplier-service:3002/health',
  'order-service': 'http://order-service:3003/health',
  'credit-service': 'http://credit-service:3004/health',
  'chat-service': 'http://chat-service:3006/health',
};

describe('the stack’s readiness (PLT-13)', () => {
  it('starts the web app only once all four services are healthy', () => {
    const deps = services['web-app']!.depends_on!;
    for (const name of ['user-service', 'supplier-service', 'order-service', 'credit-service']) {
      expect(deps[name], name).toEqual({ condition: 'service_healthy' });
    }
  });

  it('answers /edge/ready from readiness.js, and the edge’s health check asks it', () => {
    expect(nginx).toMatch(/^load_module modules\/ngx_http_js_module\.so;$/m);
    expect(nginx).toContain('js_import readiness from readiness.js;');
    expect(nginx).toMatch(/location = \/edge\/ready \{[^}]*js_content readiness\.check;/);
    expect(nginx).toMatch(/^\s+js_fetch_timeout \d+s;$/m);
    const edge = services.edge!;
    expect(edge.volumes).toContain('./edge/readiness.js:/etc/nginx/foc/readiness.js:ro');
    expect(edge.healthcheck!.test.join(' ')).toContain('http://127.0.0.1:8080/edge/ready');
    // Ready within 90 s of starting (PL-NFR1.1.1); until then a failed check is not unhealthy.
    expect(edge.healthcheck!.start_period).toBe('90s');
  });

  it('stays healthy while the services restart under it, so `up --wait` does not give up', () => {
    // A second `up --build` recreates every service under the running edge: about 15 s with
    // nothing ready, on CI. With 15 s of tolerance the edge turned unhealthy as the web app came
    // back, and `--wait` failed on it (#319). `--wait` still waits on each service's own health
    // check, and /edge/ready answers 503 at once all the while.
    const { interval, retries } = services.edge!.healthcheck!;
    expect(Number.parseInt(interval!, 10) * retries!).toBeGreaterThanOrEqual(60);
    expect(interval).toMatch(/^\d+s$/);
  });
});

describe('edge/readiness.js', () => {
  type Reply = number | Error;
  interface Answer {
    status?: number;
    body?: string;
    headers: Record<string, string>;
  }
  const asked: string[] = [];
  afterEach(() => {
    asked.length = 0;
    delete (globalThis as { ngx?: unknown }).ngx;
  });

  /** Runs the handler with each upstream answering as given (200 when not named). */
  async function ready(replies: Partial<Record<keyof typeof UPSTREAMS, Reply>> = {}) {
    const byUrl = new Map(
      Object.entries(UPSTREAMS).map(([name, url]) => [
        url,
        replies[name as keyof typeof UPSTREAMS],
      ]),
    );
    (globalThis as { ngx?: unknown }).ngx = {
      fetch: async (url: string) => {
        asked.push(url);
        const reply = byUrl.get(url) ?? 200;
        if (reply instanceof Error) throw reply;
        return { status: reply };
      },
    };
    const { default: readiness } = (await import(join(ROOT, 'edge/readiness.js'))) as {
      default: { check: (r: unknown) => Promise<void> };
    };
    const answer: Answer = { headers: {} };
    await readiness.check({
      headersOut: answer.headers,
      return(status: number, body: string) {
        answer.status = status;
        answer.body = body;
      },
    });
    return { ...answer, json: JSON.parse(answer.body!) as Record<string, unknown> };
  }

  it('answers 200 while the web app and every service answer theirs', async () => {
    const answer = await ready();
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({
      status: 'ok',
      down: [],
      checks: Object.fromEntries(Object.keys(UPSTREAMS).map((name) => [name, 'up'])),
    });
    expect(answer.headers['Content-Type']).toBe('application/json');
    expect(answer.headers['Cache-Control']).toBe('no-store');
  });

  it('answers 503 naming a service whose health check says it is unavailable', async () => {
    const answer = await ready({ 'order-service': 503 });
    expect(answer.status).toBe(503);
    expect(answer.json.status).toBe('unavailable');
    expect(answer.json.down).toEqual(['order-service']);
    expect((answer.json.checks as Record<string, string>)['order-service']).toBe('down');
  });

  it('counts one that cannot be reached, or does not answer in time, as down', async () => {
    const answer = await ready({
      'credit-service': new Error('connect failed'),
      'web-app': new Error('fetch timeout'),
    });
    expect(answer.status).toBe(503);
    expect(answer.json.down).toEqual(['web-app', 'credit-service']);
  });

  it('asks each of them once, for its health check only, never an internal route', async () => {
    await ready();
    expect([...asked].sort()).toEqual(Object.values(UPSTREAMS).sort());
    for (const url of asked) expect(url).not.toMatch(/internal|metrics/i);
  });
});
