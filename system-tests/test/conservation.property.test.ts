import { afterEach, describe, expect, it } from 'vitest';
import { TEST_POSTGRES_URL } from '@foc/test-harness';
import { simulate } from '../src/simulation.js';
import { Stack } from '../src/stack.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;

/**
 * NTH-05 / N3.1: across randomised order sequences — random actors, random rewards, refused
 * actions, lapsed deadlines, dropped and duplicated messages and reconciliation — no wallet goes
 * negative or fractional, every ledger transaction balances, total credits change only by
 * issuance, each order is reserved at most once and ends with at most one terminal outcome, and
 * Order and Credit agree once settled.
 *
 * The CI run is bounded. `PROPERTY_SEEDS` (comma-separated) and `PROPERTY_STEPS` widen it;
 * `npm run load -w @foc/system-tests` runs the heavier profile. A failure names its seed:
 * `PROPERTY_SEEDS=<seed> npm test -w @foc/system-tests` replays it exactly.
 */
const SEEDS = (process.env.PROPERTY_SEEDS ?? '1,2,3,4,5').split(',').map(Number);
const STEPS = Number(process.env.PROPERTY_STEPS ?? 60);

suite('credit conservation across randomised order sequences', () => {
  let stack: Stack | undefined;
  afterEach(async () => stack?.stop());

  it.each(SEEDS)('seed %i', async (seed) => {
    stack = await Stack.start(TEST_POSTGRES_URL!, `prop_${seed}`);
    const result = await simulate(stack, {
      seed,
      users: 6,
      steps: STEPS,
      dropRate: 0.1,
      duplicateRate: 0.15,
    });
    const { violations, ...summary } = result;
    console.log(JSON.stringify(summary));
    expect(violations, `replay with PROPERTY_SEEDS=${seed}`).toEqual([]);
    // The run really exercised the economy, not just refusals.
    expect(result.orders).toBeGreaterThan(5);
    expect(result.deliveries.handled).toBeGreaterThan(result.orders);
  });
});
