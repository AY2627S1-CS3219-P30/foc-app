import { describe, expect, it } from 'vitest';
import { BrokerConnection } from './connection.js';
import { HEADER_SENDER, resendProperties, senderOf } from './sender.js';

describe('who published a message (PLT-06)', () => {
  it('is the broker account in user-id, which the broker checked against the login', () => {
    expect(senderOf({ userId: 'user-service' }, 'credit-service')).toBe('user-service');
  });

  it('is nobody when the publisher did not say', () => {
    expect(senderOf({}, 'credit-service')).toBeUndefined();
    expect(senderOf({ userId: '' }, 'credit-service')).toBeUndefined();
  });

  it('ignores a claimed sender on a message another account published', () => {
    // Anyone can write a header; only the account itself can publish under its own user-id.
    const forged = { userId: 'order-service', headers: { [HEADER_SENDER]: 'user-service' } };
    expect(senderOf(forged, 'credit-service')).toBe('order-service');
  });

  it('is the recorded first sender on a message this service published again itself', () => {
    const retried = { userId: 'credit-service', headers: { [HEADER_SENDER]: 'user-service' } };
    expect(senderOf(retried, 'credit-service')).toBe('user-service');
  });

  it('publishes again under this service’s own account, keeping who first sent it', () => {
    const original = { userId: 'user-service', messageId: 'e1', headers: { 'x-other': 1 } };
    expect(resendProperties(original, 'credit-service')).toEqual({
      userId: 'credit-service',
      messageId: 'e1',
      headers: { 'x-other': 1, [HEADER_SENDER]: 'user-service' },
    });
    // A second retry does not lose it.
    const again = resendProperties(resendProperties(original, 'credit-service'), 'credit-service');
    expect(again.headers).toMatchObject({ [HEADER_SENDER]: 'user-service' });
  });

  it('claims no account when the service has none of its own', () => {
    const original = { userId: 'user-service', headers: {} };
    expect(resendProperties(original, undefined).userId).toBeUndefined();
  });
});

describe('the account a service signs in with', () => {
  const connection = (url: string, service: string) => new BrokerConnection(url, service);

  it('is read from the connection URL', () => {
    expect(connection('amqp://credit-service:pw@rabbitmq:5672', 'credit-service').account).toBe(
      'credit-service',
    );
    expect(connection('amqp://rabbitmq:5672', 'credit-service').account).toBeUndefined();
  });

  it('makes the service hold others to theirs only when it signs in as itself', () => {
    expect(
      connection('amqp://credit-service:pw@rabbitmq:5672', 'credit-service').verifiesSenders,
    ).toBe(true);
    // One shared login, as in a test run or `npm run dev`: there is no account to check.
    expect(connection('amqp://foc:pw@localhost:5672', 'credit-service').verifiesSenders).toBe(
      false,
    );
    expect(connection('amqp://memory', 'credit-service').verifiesSenders).toBe(false);
  });
});
