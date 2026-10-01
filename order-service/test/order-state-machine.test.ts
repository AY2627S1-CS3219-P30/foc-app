import { describe, expect, it } from 'vitest';
import {
  ORDER_ACTIONS,
  ORDER_ACTORS,
  ORDER_TRANSITIONS,
  decideTransition,
  type TransitionContext,
} from '../src/orders/order-state-machine.js';
import { ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from '../src/orders/types.js';

const contexts: readonly TransitionContext[] = [
  {},
  { acceptanceDeadlinePassed: true },
  { deliveryPeriodPassed: true },
  { requesterSuspended: true },
  { reasonProvided: true },
  { releaseReason: 'CANCELLED' },
  { releaseReason: 'EXPIRED' },
];

describe('generated transition authorization matrix', () => {
  it('tries every status/action/actor/context combination and permits only a declared rule', () => {
    for (const status of ORDER_STATUSES) {
      for (const action of ORDER_ACTIONS) {
        for (const actor of ORDER_ACTORS) {
          for (const context of contexts) {
            const decision = decideTransition(status, action, actor, context);
            const declared = ORDER_TRANSITIONS.some(
              (rule) =>
                rule.from === status &&
                rule.action === action &&
                rule.actors.includes(actor) &&
                (!rule.guard || rule.guard(context)),
            );
            expect(decision !== null, `${status} / ${action} / ${actor}`).toBe(declared);
          }
        }
      }
    }
  });

  it('never lets a requester accept their own errand or a non-admin resolve a dispute', () => {
    expect(decideTransition('OPEN', 'ACCEPT', 'REQUESTER')).toBeNull();
    expect(
      decideTransition('DISPUTED', 'RESOLVE_FOR_COURIER', 'OTHER_STUDENT', {
        reasonProvided: true,
      }),
    ).toBeNull();
    expect(
      decideTransition('DISPUTED', 'RESOLVE_FOR_REQUESTER', 'REQUESTER', { reasonProvided: true }),
    ).toBeNull();
  });

  it('makes every status reachable and gives every non-terminal status an exit', () => {
    const reachable = new Set<string>(['PENDING_CREDIT']);
    let changed = true;
    while (changed) {
      changed = false;
      for (const rule of ORDER_TRANSITIONS) {
        if (!reachable.has(rule.from)) continue;
        const target = rule.decide({ releaseReason: 'CANCELLED' }).to;
        if (!reachable.has(target)) {
          reachable.add(target);
          changed = true;
        }
      }
    }
    expect([...reachable].sort()).toEqual([...ORDER_STATUSES].sort());
    for (const status of ORDER_STATUSES) {
      const hasExit = ORDER_TRANSITIONS.some((rule) => rule.from === status);
      expect(hasExit, status).toBe(!TERMINAL_ORDER_STATUSES.includes(status as never));
    }
  });
});
