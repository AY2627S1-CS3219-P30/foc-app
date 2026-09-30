import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertJournalOrdered } from './migrations.js';

function folderWithJournal(entries: { tag: string; when: number }[]): string {
  const folder = mkdtempSync(join(tmpdir(), 'journal-'));
  mkdirSync(join(folder, 'meta'));
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ entries }));
  return folder;
}

describe('assertJournalOrdered', () => {
  it('accepts migrations generated in order', () => {
    const folder = folderWithJournal([
      { tag: '0000_init', when: 1 },
      { tag: '0001_next', when: 2 },
    ]);
    expect(() => assertJournalOrdered(folder)).not.toThrow();
  });

  it('rejects a migration older than the one before it, which Drizzle would skip', () => {
    const folder = folderWithJournal([
      { tag: '0000_init', when: 1 },
      { tag: '0001_later', when: 3 },
      { tag: '0002_merged_late', when: 2 },
    ]);
    expect(() => assertJournalOrdered(folder)).toThrow(/0002_merged_late is older than 0001_later/);
  });
});
