import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * NTH-04 (#164) — scripts-scan-vulnerabilities.sh, with `docker` replaced by a stand-in for the
 * Trivy container. The stand-in answers each target as the test says (no finding, a critical one
 * with a fix, or Trivy failing, as it does when the database download is rate-limited) and logs
 * every call, so the tests see what the script does with each answer, and how often it asks.
 */
const ROOT = resolve(import.meta.dirname, '../..');

// Reads the report directory the script mounts at /out; `convert` reads the report back.
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
out="" prev=""
for arg in "$@"; do
  [[ "$prev" == "-v" && "$arg" == *:/out ]] && out="\${arg%:/out}"
  prev="$arg"
done
if [[ " $* " == *" convert "* ]]; then
  if [[ " $* " == *" --exit-code 3 "* ]]; then grep -q CRITICAL "$out/report.json" && exit 3; exit 0; fi
  echo "(the table)"
  exit 0
fi
target="\${*: -1}"
case "$(sed -n "s|^$target=||p" "$FAKE_OUTCOMES")" in
  broken) echo "FATAL: TOOMANYREQUESTS" >&2; exit 1 ;;
  critical) echo '{"Results":[{"Vulnerabilities":[{"Severity":"CRITICAL"}]}]}' > "$out/report.json" ;;
  *) echo '{"Results":[]}' > "$out/report.json" ;;
esac
`;

type Outcome = 'clean' | 'critical' | 'broken';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scan(outcomes: Record<string, Outcome>, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'foc-scan-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'docker'), FAKE_DOCKER);
  chmodSync(join(dir, 'docker'), 0o755);
  const lines = Object.entries(outcomes).map(([target, outcome]) => `${target}=${outcome}\n`);
  writeFileSync(join(dir, 'outcomes'), lines.join(''));
  const log = join(dir, 'log');
  const run = spawnSync(
    'bash',
    [join(ROOT, 'scripts-scan-vulnerabilities.sh'), '--image', ...Object.keys(outcomes)],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_LOG: log,
        FAKE_OUTCOMES: join(dir, 'outcomes'),
        TRIVY_CACHE: join(dir, 'cache'),
        FOC_TRIVY_SKIP_DB_UPDATE: '',
        ...env,
      },
    },
  );
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return {
    status: run.status,
    output: run.stdout + run.stderr,
    analyses: calls.filter((call) => !call.includes(' convert ')),
  };
}

describe('the vulnerability scan script', () => {
  it('scans every image when Trivy fails on one, and fails the run', () => {
    const { status, output } = scan({ 'foc-a:ci': 'broken', 'foc-b:ci': 'clean' });
    expect(output).toContain('foc-a:ci: Trivy did not run (exit 1)');
    expect(output).toContain('foc-b:ci: no critical vulnerability with a fix');
    expect(output).toContain('1 scan(s) failed.');
    expect(status).toBe(1);
  });

  it('fails on a critical vulnerability with a fix, and lists the findings', () => {
    const { status, output } = scan({ 'foc-a:ci': 'critical', 'foc-b:ci': 'clean' });
    expect(output).toContain('foc-a:ci: a critical vulnerability with a fix (listed above)');
    expect(output).toContain('(the table)');
    expect(output).toContain('foc-b:ci: no critical vulnerability with a fix');
    expect(status).toBe(1);
  });

  it('passes when nothing critical has a fix', () => {
    const { status, output } = scan({ 'foc-a:ci': 'clean' });
    expect(output).toContain('No critical vulnerability with a fix.');
    expect(status).toBe(0);
  });

  it('analyses each image once, listing and gating from the one report', () => {
    const { analyses } = scan({ 'foc-a:ci': 'clean', 'foc-b:ci': 'critical' });
    expect(analyses).toHaveLength(2);
  });

  it('skips the database download only when CI restored today’s copy', () => {
    expect(scan({ 'foc-a:ci': 'clean' }).analyses[0]).not.toContain('--skip-db-update');
    const cached = scan({ 'foc-a:ci': 'clean' }, { FOC_TRIVY_SKIP_DB_UPDATE: 'true' });
    expect(cached.analyses[0]).toContain('--skip-db-update');
  });
});
