import amqp from 'amqplib';
import { describe, expect, it, vi } from 'vitest';
import { BrokerConnection } from './connection.js';

vi.mock('amqplib', () => ({ default: { connect: vi.fn() } }));

describe('BrokerConnection', () => {
  it('connects with Nagle off, so a publish never waits for a delayed ACK (#392)', async () => {
    vi.mocked(amqp.connect).mockRejectedValue(new Error('no broker here'));

    await expect(new BrokerConnection('amqp://svc:pw@broker', 'svc').connect()).rejects.toThrow(
      'no broker here',
    );

    expect(amqp.connect).toHaveBeenCalledWith('amqp://svc:pw@broker', { noDelay: true });
  });
});
