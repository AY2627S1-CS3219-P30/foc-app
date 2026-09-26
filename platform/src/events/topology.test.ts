import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  deadLetterQueueName,
  retryExchangeName,
  retryLevels,
  retryQueueName,
} from './topology.js';

describe('retry topology', () => {
  it('allows five attempts in total', () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(RETRY_DELAYS_MS).toHaveLength(4);
  });

  it('backs off progressively rather than hammering a failing dependency', () => {
    const ascending = [...RETRY_DELAYS_MS].every((d, i, a) => i === 0 || d > (a[i - 1] as number));
    expect(ascending).toBe(true);
  });

  it('exhausts every attempt inside the five-minute bound in EI-NFR1.1.2', () => {
    const total = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(5 * 60 * 1000);
  });

  it('gives each delay level its own exchange and queue', () => {
    const levels = retryLevels('credit-service');
    expect(levels).toHaveLength(RETRY_DELAYS_MS.length);
    expect(new Set(levels.map((l) => l.exchange)).size).toBe(levels.length);
    levels.forEach((l, i) => {
      expect(l.exchange).toBe(retryExchangeName('credit-service', i + 1));
      expect(l.queue).toBe(retryQueueName('credit-service', i + 1));
      expect(l.ttlMs).toBe(RETRY_DELAYS_MS[i]);
    });
  });

  it('scopes retry queues per service, so two services can tune backoff independently', () => {
    const a = retryLevels('user-service').map((l) => l.queue);
    const b = retryLevels('credit-service').map((l) => l.queue);
    expect(a).not.toEqual(b);
    expect(a[0]).toBe('foc.user-service.retry.1');
  });

  it('derives a dead-letter queue name from the queue it serves', () => {
    expect(deadLetterQueueName('foc.credit.wallet')).toBe('foc.credit.wallet.dlq');
  });
});
