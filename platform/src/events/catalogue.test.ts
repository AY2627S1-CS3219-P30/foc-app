import { describe, expect, it } from 'vitest';
import {
  EVENTS,
  creditReservationRejectedPayload,
  creditReservationRequestedPayload,
  creditsReservedPayload,
} from './catalogue.js';

const reservation = { orderId: 'order-1', requesterId: 'user-1', amount: 3 };

describe('event catalogue', () => {
  it('gives every event its own routing key, so two workflows never share a queue binding', () => {
    const keys = Object.values(EVENTS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('prefixes every routing key with a service name', () => {
    for (const key of Object.values(EVENTS)) {
      expect(key).toMatch(/^(user|supplier|order|credit)\.[a-z]+(-[a-z]+)*$/);
    }
  });

  it('prefixes a request by the service that sends it, not the one that acts on it', () => {
    expect(EVENTS.CREDIT_RESERVATION_REQUESTED).toBe('order.reservation-requested');
    expect(EVENTS.CREDIT_RELEASE_REQUESTED).toBe('order.release-requested');
  });
});

describe('credit reservation payloads', () => {
  it('accepts a reservation of whole credits for a named errand and requester', () => {
    expect(creditReservationRequestedPayload.safeParse(reservation).success).toBe(true);
    expect(creditsReservedPayload.safeParse(reservation).success).toBe(true);
  });

  it.each([0, -1, 2.5])('treats an amount of %s as malformed', (amount) => {
    expect(creditReservationRequestedPayload.safeParse({ ...reservation, amount }).success).toBe(
      false,
    );
  });

  it('refuses a request that does not say whose credits to reserve', () => {
    const { requesterId: _, ...anonymous } = reservation;
    expect(creditReservationRequestedPayload.safeParse(anonymous).success).toBe(false);
  });

  it('leaves the reward range to the Credit Service, so an out-of-range amount still gets a reply', () => {
    expect(creditReservationRequestedPayload.safeParse({ ...reservation, amount: 6 }).success).toBe(
      true,
    );
  });

  it('carries the available balance when credits are insufficient (OS-FR1.1.1)', () => {
    const rejection = { ...reservation, reason: 'INSUFFICIENT_CREDITS' };
    expect(creditReservationRejectedPayload.safeParse(rejection).success).toBe(false);
    expect(creditReservationRejectedPayload.safeParse({ ...rejection, available: 1 }).success).toBe(
      true,
    );
  });

  it('refuses a rejection with a reason no consumer knows how to handle', () => {
    const rejection = { ...reservation, reason: 'NO_WALLET' };
    expect(creditReservationRejectedPayload.safeParse(rejection).success).toBe(false);
  });
});
