import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ContractValidator,
  EVENT_SCHEMAS_FILE,
  findOpenApiBreakingChanges,
  loadContract,
  renderEventSchemas,
  type ContractName,
} from '../src/index.js';

const CONTRACTS: ContractName[] = [
  'user-service',
  'supplier-service',
  'order-service',
  'credit-service',
];
const METHODS = ['get', 'put', 'post', 'delete', 'patch'];

describe('published contracts', () => {
  it.each(CONTRACTS)('%s: every documented JSON response schema compiles', (name) => {
    const validator = ContractValidator.for(name);
    let compiled = 0;
    for (const [path, item] of Object.entries(validator.doc.paths)) {
      for (const method of METHODS) {
        const operation = item[method] as { responses?: Record<string, unknown> } | undefined;
        for (const status of Object.keys(operation?.responses ?? {})) {
          if (!/^\d{3}$/.test(status)) continue;
          // Validating an impossible value proves the schema resolved and compiled.
          expect(() =>
            validator.check(method, path, { status: Number(status), body: Symbol() as never }),
          ).not.toThrow();
          compiled += 1;
        }
      }
    }
    expect(compiled).toBeGreaterThan(0);
  });

  it.each(CONTRACTS)('%s: is compatible with itself', (name) => {
    expect(findOpenApiBreakingChanges(loadContract(name), loadContract(name))).toEqual([]);
  });

  it('contracts/events.schema.json is current with the event catalogue', () => {
    expect(readFileSync(EVENT_SCHEMAS_FILE, 'utf8')).toBe(renderEventSchemas());
  });
});

describe('ContractValidator', () => {
  const credit = ContractValidator.for('credit-service');

  it('reports undocumented operations and statuses', () => {
    expect(credit.check('get', '/nope', { status: 200, body: {} })).toEqual([
      'credit-service GET /nope → 200: operation is not in the contract',
    ]);
    expect(credit.check('get', '/wallets/me', { status: 418, body: {} })[0]).toMatch(
      /status is not documented/,
    );
  });

  it('rejects a body that violates the documented schema', () => {
    const violations = credit.check('get', '/wallets/me', {
      status: 200,
      body: { userId: 42 },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(() => credit.assert('get', '/wallets/me', { status: 200, body: {} })).toThrow(
      /credit-service GET \/wallets\/me → 200/,
    );
  });
});
