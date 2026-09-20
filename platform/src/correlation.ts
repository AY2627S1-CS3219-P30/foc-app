import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Header carrying the correlation ID across every hop, HTTP and broker alike. */
export const CORRELATION_HEADER = 'x-correlation-id';

/** Header naming the event or request that caused this one. */
export const CAUSATION_HEADER = 'x-causation-id';

/**
 * Returns the inbound correlation ID, or mints one when the caller did not send
 * a usable value. The same ID is echoed on the response so a browser, a test or
 * an operator can follow one request through every service.
 */
export function resolveCorrelationId(req: IncomingMessage): string {
  const raw = req.headers[CORRELATION_HEADER];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    // Bound the length so a hostile header cannot bloat every log line.
    if (trimmed.length > 0 && trimmed.length <= 128) return trimmed;
  }
  return randomUUID();
}

/** Echoes the correlation ID back to the caller. */
export function echoCorrelationId(res: ServerResponse, correlationId: string): void {
  if (!res.headersSent) res.setHeader(CORRELATION_HEADER, correlationId);
}
