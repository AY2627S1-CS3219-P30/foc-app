import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * NTH-04 (#164) — what the pipeline must keep checking: a vulnerable dependency, a tool version
 * that can move under us, and a folder nobody is asked to review. Read as text and YAML, so a
 * change that drops one of these gates fails in the Node job, before anything is built.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
const jobs = (
  yaml.load(read('.github/workflows/ci.yml')) as { jobs: Record<string, { steps: Step[] }> }
).jobs;
const runs = (job: string) => jobs[job]!.steps.map((step) => step.run ?? '').join('\n');

describe('the vulnerability scan (PL-NFR4.1.2)', () => {
  it('scans each changed service’s image, the web app’s, and the production lockfile', () => {
    const build = jobs.service!.steps.find((step) => step.name === 'Build image')!;
    expect(build.with).toMatchObject({ load: true, tags: 'foc-${{ matrix.service }}:ci' });
    expect(runs('service')).toContain(
      './scripts-scan-vulnerabilities.sh --image foc-${{ matrix.service }}:ci',
    );
    expect(runs('web-app')).toContain('./scripts-scan-vulnerabilities.sh --image foc-web-app:ci');
    expect(runs('quality')).toContain('./scripts-scan-vulnerabilities.sh --lockfile');
  });

  it('fails on a critical vulnerability that has a fix, with a pinned Trivy', () => {
    const script = read('scripts-scan-vulnerabilities.sh');
    expect(script).toMatch(/^TRIVY='aquasec\/trivy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}'$/m);
    expect(script).toContain('--severity CRITICAL');
    expect(script).toContain('--ignore-unfixed');
  });
});

describe('tool versions', () => {
  it('pins Bun in CI to the version the web app’s image builds with', () => {
    const image = read('web-app/Dockerfile').match(/^FROM oven\/bun:(\d+\.\d+\.\d+)/m)![1];
    const versions = [...read('.github/workflows/ci.yml').matchAll(/bun-version:\s*(\S+)/g)].map(
      ([, version]) => version,
    );
    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions)).toEqual(new Set([image]));
  });
});

describe('code owners', () => {
  const owners = Object.fromEntries(
    read('.github/CODEOWNERS')
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => {
        const [path, ...who] = line.trim().split(/\s+/);
        return [path!, who];
      }),
  );

  it('names a reviewer for every service, the web app, the shared code and the pipeline', () => {
    for (const path of [
      '/user-service/',
      '/supplier-service/',
      '/order-service/',
      '/credit-service/',
      '/web-app/',
      '/platform/',
      '/auth-client/',
      '/contracts/',
      '/.github/',
      '/compose.yaml',
    ]) {
      expect(owners[path], path).toBeDefined();
      for (const who of owners[path]!) expect(who, path).toMatch(/^@[A-Za-z0-9-]+$/);
    }
  });

  it('asks each service’s owner to review that service', () => {
    expect(owners['/user-service/']).toContain('@anselmlong');
    expect(owners['/supplier-service/']).toContain('@pastchum');
    expect(owners['/order-service/']).toContain('@volleyballkickedme');
    expect(owners['/credit-service/']).toContain('@isaacchua0309');
  });
});
