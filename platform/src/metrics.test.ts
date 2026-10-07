import type { Request, Response } from 'express';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { requestLogger } from './logging.js';
import { Metrics, MetricsController } from './metrics.js';

/** The value of one series of a metric, matched on the labels given. */
async function seriesValue(
  metric: { get(): Promise<{ values: { labels: object; value: number; metricName?: string }[] }> },
  labels: Record<string, string>,
  metricName?: string,
): Promise<number | undefined> {
  const { values } = await metric.get();
  return values.find(
    (v) =>
      (metricName === undefined || v.metricName === metricName) &&
      Object.entries(labels).every(
        ([k, want]) => String((v.labels as Record<string, unknown>)[k]) === want,
      ),
  )?.value;
}

/** Runs one request through the request logger; `route` is what Express sets when a route matched. */
function serve(metrics: Metrics, path: string, statusCode: number, route?: string) {
  let finish: () => void = () => undefined;
  const req = {
    headers: {},
    method: 'GET',
    url: path,
    originalUrl: path,
    baseUrl: '',
    ...(route ? { route: { path: route } } : {}),
  } as unknown as Request;
  const res = {
    statusCode,
    setHeader: () => undefined,
    on: (_event: string, listener: () => void) => void (finish = listener),
  } as unknown as Response;
  requestLogger(pino({ enabled: false }), metrics)(req, res, () => undefined);
  finish();
}

describe('HTTP latency (PLT-04)', () => {
  it('counts a request under its route pattern, method and status', async () => {
    const metrics = new Metrics('test-service');
    serve(metrics, '/orders/0b7c2c1e-6f1d-4c4e-9d53-2f1c7d0b9a11', 200, '/orders/:id');
    serve(metrics, '/orders/5c1f2a9e-0000-4000-8000-000000000000', 200, '/orders/:id');
    serve(metrics, '/orders/5c1f2a9e-0000-4000-8000-000000000000', 404, '/orders/:id');

    const ok = { method: 'GET', route: '/orders/:id', status: '200' };
    expect(await seriesValue(metrics.httpDuration, ok, 'http_request_duration_seconds_count')).toBe(
      2,
    );
    expect(
      await seriesValue(
        metrics.httpDuration,
        { ...ok, status: '404' },
        'http_request_duration_seconds_count',
      ),
    ).toBe(1);
  });

  it('labels a request no route matched as unmatched, so a raw path never becomes a label', async () => {
    const metrics = new Metrics('test-service');
    serve(metrics, '/admin/users/alice@u.nus.edu', 404);

    expect(
      await seriesValue(
        metrics.httpDuration,
        { route: 'unmatched', status: '404' },
        'http_request_duration_seconds_count',
      ),
    ).toBe(1);
    expect(await metrics.render()).not.toContain('alice');
  });

  it('does not time the polled endpoints, /health and /metrics', async () => {
    const metrics = new Metrics('test-service');
    serve(metrics, '/health', 200, '/health');
    serve(metrics, '/metrics', 200, '/metrics');

    expect((await metrics.httpDuration.get()).values).toEqual([]);
  });

  it('labels every series with the service, for one dashboard across services', async () => {
    const metrics = new Metrics('order-service');
    serve(metrics, '/orders', 200, '/orders');

    expect(await metrics.render()).toMatch(
      /http_request_duration_seconds_count\{[^}]*service="order-service"[^}]*\} 1/,
    );
  });
});

describe('gauges a service adds', () => {
  it('reports what collect sets, read when scraped', async () => {
    const metrics = new Metrics('test-service');
    let open = 3;
    metrics.addGauge({
      name: 'test_orders',
      help: 'Orders by status.',
      labelNames: ['status'],
      collect: (set) => {
        set({ status: 'OPEN' }, open);
        set({ status: 'COMPLETED' }, 7);
      },
    });

    expect(await metrics.render()).toMatch(/test_orders\{status="OPEN"[^}]*\} 3/);
    open = 4;
    expect(await metrics.render()).toMatch(/test_orders\{status="OPEN"[^}]*\} 4/);
  });

  it('drops a series collect no longer sets, so a status that emptied stops being reported', async () => {
    const metrics = new Metrics('test-service');
    let statuses = ['OPEN', 'ACCEPTED'];
    metrics.addGauge({
      name: 'test_orders',
      help: 'Orders by status.',
      labelNames: ['status'],
      collect: (set) => statuses.forEach((status) => set({ status }, 1)),
    });
    await metrics.render();
    statuses = ['OPEN'];

    expect(await metrics.render()).not.toContain('status="ACCEPTED"');
  });

  it('keeps the rest of a scrape when one gauge fails, so the service is not reported down', async () => {
    const metrics = new Metrics('test-service');
    metrics.addGauge({
      name: 'test_broken',
      help: 'Reads a database that is down.',
      collect: () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    serve(metrics, '/orders', 200, '/orders');

    const text = await metrics.render();
    // Unknown, not 0: an empty outbox and an unreachable database must not look the same.
    expect(text).toMatch(/^test_broken\{[^}]*\} NaN$/im);
    expect(text).toContain('http_request_duration_seconds_count');
  });

  it('reports no series for a labelled gauge that fails', async () => {
    const metrics = new Metrics('test-service');
    metrics.addGauge({
      name: 'test_broken_by_status',
      help: 'Reads a database that is down.',
      labelNames: ['status'],
      collect: () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    expect(await metrics.render()).not.toMatch(/^test_broken_by_status\{/m);
  });
});

describe('GET /metrics', () => {
  it('serves the registry in Prometheus text format', async () => {
    const metrics = new Metrics('test-service');
    serve(metrics, '/orders', 201, '/orders');

    const body = await new MetricsController(metrics).scrape();

    expect(body).toContain('# TYPE http_request_duration_seconds histogram');
    expect(body).toContain('foc_events_handled_total');
  });
});
