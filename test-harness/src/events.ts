import { z } from 'zod';
import { PAYLOAD_SCHEMAS } from '@foc/platform';
import { CONTRACTS_DIR } from './contracts.js';

export const EVENT_SCHEMAS_FILE = `${CONTRACTS_DIR}events.schema.json`;

/**
 * The event catalogue's Zod payload schemas rendered as JSON Schema, keyed by routing key. The
 * rendered file is committed under contracts/ so the compatibility check can diff it against the
 * base branch, and a test fails if it falls behind the catalogue.
 */
export function renderEventSchemas(): string {
  const events = Object.fromEntries(
    Object.entries(PAYLOAD_SCHEMAS)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([eventType, schema]) => [eventType, z.toJSONSchema(schema as z.ZodType)]),
  );
  return `${JSON.stringify(
    {
      $comment:
        'Generated from platform/src/events/catalogue.ts by `npm run contracts:events`. Do not edit.',
      events,
    },
    null,
    2,
  )}\n`;
}
