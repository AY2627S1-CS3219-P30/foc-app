import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('../../scripts-recovery.py', import.meta.url));
const databases = ['foc_user', 'foc_supplier', 'foc_order', 'foc_credit', 'foc_chat'];

describe('backup bundle integrity before restore (PLT-09)', () => {
  let bundle: string;
  let manifest: { format: number; databases: Record<string, unknown> };
  beforeEach(() => {
    bundle = mkdtempSync(join(tmpdir(), 'foc-recovery-test-'));
    manifest = { format: 1, databases: {} };
    for (const db of databases) {
      const content = Buffer.from(`PGDMP disposable verifier fixture ${db}`);
      writeFileSync(join(bundle, `${db}.dump`), content);
      manifest.databases[db] = {
        sha256: createHash('sha256').update(content).digest('hex'),
        tables: { 'public.sample': { rows: 2, sha256: 'a'.repeat(64) } },
      };
    }
    save();
  });
  afterEach(() => rmSync(bundle, { recursive: true, force: true }));
  const save = () => writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest));
  const verify = () => spawnSync('python3', [helper, 'verify', bundle], { encoding: 'utf8' });

  it('accepts all five independently checksummed custom-format dumps', () => {
    const result = verify();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('refuses corruption and a missing database before any restore can run', () => {
    writeFileSync(join(bundle, 'foc_credit.dump'), 'PGDMP changed');
    expect(verify().stderr).toContain('Checksum mismatch for foc_credit');
    expect(verify().status).toBe(1);
    delete manifest.databases.foc_order;
    save();
    expect(verify().stderr).toContain('exactly the five service databases');
    expect(verify().stderr).not.toContain('before the Chat Service');
  });

  it('refuses a backup from before the Chat Service, and says which release restores it', () => {
    delete manifest.databases.foc_chat;
    save();
    const result = verify();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'a backup from before the Chat Service is restored with the release that made it',
    );
  });

  it('refuses a non-custom archive even if its checksum matches', () => {
    const content = Buffer.from('plain SQL is not the accepted backup format');
    writeFileSync(join(bundle, 'foc_credit.dump'), content);
    manifest.databases.foc_credit = {
      sha256: createHash('sha256').update(content).digest('hex'),
      tables: { 'public.sample': { rows: 2, sha256: 'a'.repeat(64) } },
    };
    save();
    expect(verify().stderr).toContain('not a custom-format');
    expect(verify().status).toBe(1);
  });

  it('refuses linked archives and incomplete fingerprint evidence', () => {
    const file = join(bundle, 'foc_user.dump');
    const target = join(bundle, 'outside.dump');
    writeFileSync(target, readFileSync(file));
    rmSync(file);
    symlinkSync(target, file);
    expect(verify().stderr).toContain('unsafe dump for foc_user');
    rmSync(file);
    writeFileSync(file, readFileSync(target));
    manifest.databases.foc_credit = { tables: {}, sha256: 'irrelevant' };
    save();
    expect(verify().status).toBe(1);
  });

  it('keeps recovery in the required Compose CI job and never accepts a mutable rollback tag', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)),
      'utf8',
    );
    expect(workflow).toContain('./scripts-recovery-drill.sh --rollback-tag "$rollback_tag"');
    const rollback = fileURLToPath(new URL('../../scripts-rollback.sh', import.meta.url));
    const result = spawnSync('bash', [rollback, 'main', '--additive-migrations-reviewed'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('sha-<40 hex commit>');
  });

  it('refuses both application and migration writers while accepting infrastructure alone', () => {
    const library = fileURLToPath(new URL('../../scripts-recovery-lib.sh', import.meta.url));
    const check = (running: string) =>
      spawnSync(
        'bash',
        [
          '-c',
          `
      . "$1"
      fake_running="$2"
      docker() { printf '%s\\n' "$fake_running"; }
      recovery_apps_stopped
    `,
          'recovery-guard-test',
          library,
          running,
        ],
        { encoding: 'utf8' },
      );
    expect(check('postgres\nrabbitmq').status).toBe(0);
    for (const writer of ['edge', 'credit-service', 'user-service-migrate']) {
      const result = check(writer);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('containers are running');
    }
  });
});
