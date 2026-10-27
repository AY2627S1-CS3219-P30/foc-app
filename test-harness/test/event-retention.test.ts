import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PLT-12 (#287) — every service with event tables prunes them, through the indexes the platform's
 * prune needs (OUTBOX_RETENTION_INDEX_SQL, INBOX_RETENTION_INDEX_SQL). Each service defines its
 * tables in its own Drizzle schema, so each must create the indexes in its own migrations.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const SERVICES = ['user-service', 'supplier-service', 'order-service', 'credit-service'];

describe('event retention in each service (PLT-12)', () => {
  for (const service of SERVICES) {
    const schema = read(`${service}/src/db/schema.ts`);
    const outbox = schema.includes("'outbox_events'");
    const inbox = schema.includes("'processed_events'");
    if (!outbox && !inbox) continue;

    it(`${service} prunes its event tables, through indexes its migrations create`, () => {
      const migrations = readdirSync(join(ROOT, service, 'drizzle'))
        .filter((file) => file.endsWith('.sql'))
        .map((file) => read(`${service}/drizzle/${file}`))
        .join('\n');
      if (outbox) expect(migrations).toContain('"outbox_events_published_idx"');
      if (inbox) expect(migrations).toContain('"processed_events_processed_idx"');
      expect(read(`${service}/src/app.module.ts`)).toMatch(
        /provideEventTablePruner\(\{ db: \w+ \}\)/,
      );
    });
  }
});
