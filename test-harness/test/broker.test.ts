import { randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import { describe, expect, it } from 'vitest';
import { createEphemeralBroker, RABBITMQ_URL } from '../src/index.js';

const suite = RABBITMQ_URL ? describe : describe.skip;

suite('ephemeral RabbitMQ fixture', () => {
  it('namespaces queues per run and deletes them on dispose', async () => {
    const first = createEphemeralBroker(RABBITMQ_URL!, 'harness');
    const second = createEphemeralBroker(RABBITMQ_URL!, 'harness');
    expect(first.namespace).not.toBe(second.namespace);
    const queue = first.queue('probe');
    expect(queue).not.toBe(second.queue('probe'));

    const conn = await amqp.connect(RABBITMQ_URL!);
    try {
      const ch = await conn.createChannel();
      await ch.assertQueue(queue, { durable: true });
      const body = randomUUID();
      ch.sendToQueue(queue, Buffer.from(body));
      await expect
        .poll(async () => (await ch.get(queue, { noAck: true })) || undefined)
        .toBeDefined();
      await ch.close();
    } finally {
      await conn.close();
    }

    await first.dispose();
    await second.dispose();

    const check = await amqp.connect(RABBITMQ_URL!);
    try {
      const ch = await check.createChannel();
      ch.on('error', () => undefined);
      await expect(ch.checkQueue(queue)).rejects.toThrow(/NOT_FOUND/);
    } finally {
      await check.close().catch(() => undefined);
    }
  });
});
