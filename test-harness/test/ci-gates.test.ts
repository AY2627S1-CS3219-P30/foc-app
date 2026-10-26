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
  if?: string;
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

  it('restores the day’s Trivy database before every scan, so a run rarely downloads it', () => {
    for (const job of ['quality', 'service', 'web-app', 'publish']) {
      const steps = jobs[job]!.steps;
      const database = steps.findIndex((step) => step.uses === './.github/actions/trivy-db');
      const scan = steps.findIndex((step) => step.run?.includes('scripts-scan-vulnerabilities.sh'));
      expect(database, job).toBeGreaterThanOrEqual(0);
      expect(database, job).toBeLessThan(scan);
    }
    const action = yaml.load(read('.github/actions/trivy-db/action.yml')) as {
      runs: { steps: Step[] };
    };
    const cache = action.runs.steps.find((step) => step.uses?.startsWith('actions/cache@'))!;
    expect(cache.with).toMatchObject({ path: '~/.cache/foc-trivy/db' });
    expect(String(cache.with!.key)).toMatch(/^trivy-db-\$\{\{ steps\.\w+\.outputs\.date \}\}$/);
    // Used as it is only when it was saved today; an older copy is updated by the scan.
    const skip = action.runs.steps.find((step) => step.run?.includes('FOC_TRIVY_SKIP_DB_UPDATE'))!;
    expect(skip.if).toContain("outputs.cache-hit == 'true'");
  });

  it('fails on a critical vulnerability that has a fix, with a pinned Trivy', () => {
    const script = read('scripts-scan-vulnerabilities.sh');
    expect(script).toMatch(/^TRIVY='aquasec\/trivy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}'$/m);
    expect(script).toContain('--severity CRITICAL');
    expect(script).toContain('--ignore-unfixed');
  });
});

describe('test coverage (PL-NFR4.1.1)', () => {
  it('is reported for each service, each shared package and the web app, without a threshold', () => {
    expect(runs('service')).toContain('npm test -w @foc/${{ matrix.service }} -- --coverage');
    expect(runs('packages')).toContain('npm test -w "$pkg" -- --coverage');
    expect(runs('web-app')).toContain('bun test --coverage');
    expect(runs('service')).toContain('./scripts-coverage-summary.sh');
    expect(runs('packages')).toContain('./scripts-coverage-summary.sh');
  });
});

describe('the web-app job', () => {
  it('builds the app once, inside its image, rather than again on the runner', () => {
    expect(runs('web-app')).not.toContain('bun run build');
    expect(
      jobs['web-app']!.steps.some((step) => step.uses?.startsWith('docker/bake-action@')),
    ).toBe(true);
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

  it('keeps @vitest/coverage-v8 in step with vitest: one version, in every package', () => {
    const workspaces = (JSON.parse(read('package.json')) as { workspaces: string[] }).workspaces;
    const ranges = workspaces.flatMap((workspace) => {
      const { devDependencies = {} } = JSON.parse(read(`${workspace}/package.json`)) as {
        devDependencies?: Record<string, string>;
      };
      if (!devDependencies.vitest) return [];
      // Its peer dependency is that exact vitest version, so the two must move together.
      expect(devDependencies['@vitest/coverage-v8'], workspace).toBe(devDependencies.vitest);
      return [devDependencies.vitest];
    });
    expect(ranges.length).toBeGreaterThan(0);
    expect(new Set(ranges).size).toBe(1);

    const { packages } = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, { version?: string }>;
    };
    const installed = (name: string) =>
      new Set(
        Object.entries(packages)
          .filter(([path]) => path.endsWith(`node_modules/${name}`))
          .map(([, entry]) => entry.version),
      );
    expect(installed('vitest').size).toBe(1);
    expect(installed('@vitest/coverage-v8')).toEqual(installed('vitest'));
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

  it('gives every path an owner, starting from a catch-all, and names the root config', () => {
    const rules = read('.github/CODEOWNERS')
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'));
    // The last matching rule wins, so the catch-all goes first and the specific rules override it.
    expect(rules[0]!.trim().split(/\s+/)[0]).toBe('*');
    for (const path of [
      '/package.json',
      '/package-lock.json',
      '/tsconfig.base.json',
      '/eslint.config.mjs',
      '/.nvmrc',
      '/compose.images.yaml',
      '/data/',
    ]) {
      expect(owners[path], path).toBeDefined();
    }
  });

  it('asks each service’s owner to review that service', () => {
    expect(owners['/user-service/']).toContain('@anselmlong');
    expect(owners['/supplier-service/']).toContain('@pastchum');
    expect(owners['/order-service/']).toContain('@volleyballkickedme');
    expect(owners['/credit-service/']).toContain('@isaacchua0309');
  });
});
