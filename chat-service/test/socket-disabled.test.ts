import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { TestApp } from './helpers/app.js';

/**
 * #346: with `CHAT_SOCKET_ENABLED=false` no upgrade is answered, so the panel's socket fails to
 * open and it keeps polling, while every HTTP route works as before.
 */
let t: TestApp;
let helpers: typeof import('./helpers/app.js');
let SocketClient: typeof import('./helpers/socket-client.js').SocketClient;

beforeAll(async () => {
  vi.stubEnv('CHAT_SOCKET_ENABLED', 'false');
  // Imported after the variable is set: the modules read their configuration at load time.
  helpers = await import('./helpers/app.js');
  ({ SocketClient } = await import('./helpers/socket-client.js'));
  t = await helpers.createTestApp();
});
afterAll(async () => {
  await t?.close();
  vi.unstubAllEnvs();
});

it('refuses every socket, and still takes messages over HTTP', async () => {
  const client = new SocketClient(t);
  await expect(client.opened()).rejects.toThrow();

  const orderId = t.upstreams.errand();
  await helpers
    .http(t)
    .post(`/channels/${orderId}/messages`)
    .set('Authorization', helpers.as('requester'))
    .send(helpers.message('still here'))
    .expect(201);
});
