import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import type { TestApp } from './app.js';

/** A browser's chat socket: every frame it receives, in order, and how it ended. */
export class SocketClient {
  readonly frames: unknown[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly ws: WebSocket;
  private waiters: (() => void)[] = [];

  constructor(t: TestApp, path = '/socket') {
    const { port } = (t.app.getHttpServer() as Server).address() as AddressInfo;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    this.ws.on('message', (data) => {
      this.frames.push(JSON.parse(String(data)));
      for (const wake of this.waiters.splice(0)) wake();
    });
    // A failed upgrade is seen through `opened()`; how the socket ended, through `closed`.
    this.ws.on('error', () => undefined);
    this.closed = new Promise((resolve) => {
      this.ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  async send(frame: unknown): Promise<void> {
    await this.opened();
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  /** Signs in as the person the token names, and waits for `ready`. */
  async signIn(token: string): Promise<this> {
    await this.send({ type: 'auth', token });
    await this.received(1);
    return this;
  }

  /** Waits until `count` frames have arrived, or fails after `withinMs`. */
  async received(count: number, withinMs = 1_000): Promise<unknown[]> {
    const deadline = Date.now() + withinMs;
    while (this.frames.length < count) {
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(
          `expected ${count} frames within ${withinMs} ms, got ${JSON.stringify(this.frames)}`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.frames.slice(0, count);
  }

  close(): void {
    this.ws.close();
  }

  /** Writes bytes straight onto the connection, past ws's framing: how a broken client looks. */
  async raw(bytes: Buffer): Promise<void> {
    await this.opened();
    (this.ws as unknown as { _socket: { write(bytes: Buffer): void } })._socket.write(bytes);
  }
}
