import { describe, expect, it } from 'vitest';
import {
  INITIAL_ALLOCATION_BOUNDS,
  INITIAL_CREDIT_ALLOCATION,
  MAX_RESERVATION_AMOUNT,
} from '../../credit-service/src/credits/types.js';
import { createOrderSchema } from '../../order-service/src/orders/validation.js';

const reward = createOrderSchema.shape.reward;

/**
 * Order decides which rewards a student may post; Credit decides which it will reserve and how
 * much a new wallet holds. Each states the maximum on its own, so this fails if they drift
 * (CRD-09): a reward Order accepts but Credit refuses, or an allocation too small to post one.
 * Needs no database, so it runs whether or not TEST_POSTGRES_URL is set.
 */
describe("Order's rewards and Credit's limits agree", () => {
  it("Order's largest reward is exactly the largest reservation Credit accepts", () => {
    expect(reward.safeParse(MAX_RESERVATION_AMOUNT).success).toBe(true);
    expect(reward.safeParse(MAX_RESERVATION_AMOUNT + 1).success).toBe(false);
  });

  it('every allowed allocation, and the default, funds the largest reward', () => {
    expect(INITIAL_ALLOCATION_BOUNDS.min).toBeGreaterThanOrEqual(MAX_RESERVATION_AMOUNT);
    expect(INITIAL_CREDIT_ALLOCATION).toBeGreaterThanOrEqual(INITIAL_ALLOCATION_BOUNDS.min);
    expect(INITIAL_CREDIT_ALLOCATION).toBeLessThanOrEqual(INITIAL_ALLOCATION_BOUNDS.max);
  });
});
