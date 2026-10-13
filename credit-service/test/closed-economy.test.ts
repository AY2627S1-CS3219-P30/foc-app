import { describe, expect, it } from 'vitest';
import { CREDIT_ECONOMIC_SUBSCRIPTIONS, CREDIT_HTTP_SURFACE } from '../src/closed-economy.js';
import { createTestApp } from './helpers/app.js';

type ExpressLayer = {
  route?: { path: string; methods: Record<string, boolean> };
};

describe('closed-economy deployed surface (CRD-06)', () => {
  it('contains only the four approved producer-scoped economic inputs', () => {
    expect(CREDIT_ECONOMIC_SUBSCRIPTIONS).toEqual([
      expect.objectContaining({ effect: 'ISSUE', expectedProducer: 'user-service' }),
      expect.objectContaining({ effect: 'RESERVE', expectedProducer: 'order-service' }),
      expect.objectContaining({ effect: 'TRANSFER', expectedProducer: 'order-service' }),
      expect.objectContaining({ effect: 'RELEASE', expectedProducer: 'order-service' }),
    ]);
  });

  it('registers an exact, GET-only HTTP surface with no balance mutation route', async () => {
    const app = await createTestApp();
    try {
      const instance = app.app.getHttpAdapter().getInstance() as {
        router?: { stack: ExpressLayer[] };
        _router?: { stack: ExpressLayer[] };
      };
      const stack = instance.router?.stack ?? instance._router?.stack ?? [];
      const routes = stack.flatMap((layer) =>
        layer.route
          ? Object.entries(layer.route.methods)
              .filter(([, enabled]) => enabled)
              .map(([method]) => `${method.toUpperCase()} ${layer.route!.path}`)
          : [],
      );
      expect(routes.sort()).toEqual([...CREDIT_HTTP_SURFACE].sort());
      expect(routes.every((route) => route.startsWith('GET '))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
