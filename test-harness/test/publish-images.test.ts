import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * NTH-04 (#164) — which images are published, under which names, and when. Read as YAML, so a
 * change that would publish from a pull request, give another job write access to the registry, or
 * leave an application image unpublished fails in the Node job, before anything runs.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const REGISTRY = 'ghcr.io/ay2627s1-cs3219-p30';
const APPLICATION = [
  'user-service',
  'supplier-service',
  'order-service',
  'credit-service',
  'web-app',
];

type Services = Record<string, { image?: string; build?: unknown }>;
const compose = (yaml.load(read('compose.yaml')) as { services: Services }).services;
const override = (yaml.load(read('compose.images.yaml')) as { services: Services }).services;

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps?: Step[];
}
const workflow = yaml.load(read('.github/workflows/ci.yml')) as {
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': string | boolean };
  jobs: Record<string, Job>;
};

describe('compose.images.yaml', () => {
  it('names a published image for every container compose.yaml builds', () => {
    const built = Object.keys(compose).filter((name) => compose[name]!.build);
    expect(Object.keys(override).sort()).toEqual(built.sort());
  });

  it('gives a service and its migrate container the same image, tagged by FOC_IMAGE_TAG', () => {
    for (const [name, service] of Object.entries(override)) {
      const application = name.replace(/-migrate$/, '');
      expect(APPLICATION, name).toContain(application);
      // Only the image: everything else, including how to build it, stays in compose.yaml.
      expect(service, name).toEqual({
        image: `${REGISTRY}/foc-${application}:\${FOC_IMAGE_TAG:-main}`,
      });
    }
  });
});

describe('the publish job', () => {
  const publish = workflow.jobs.publish!;

  it('runs only for a push to main whose checks all passed', () => {
    expect([publish.needs].flat()).toContain('ci');
    expect(publish.if).toContain("github.event_name == 'push'");
    expect(publish.if).toContain("github.ref == 'refs/heads/main'");
    expect(publish.if).toContain("needs.ci.result == 'success'");
  });

  it('is the only job that may write to the registry', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(publish.permissions).toEqual({ contents: 'read', packages: 'write' });
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name !== 'publish') expect(job.permissions?.packages, name).toBeUndefined();
    }
  });

  const steps = publish.steps!;
  const at = (find: (step: Step) => boolean, what: string) => {
    const index = steps.findIndex(find);
    expect(index, what).toBeGreaterThanOrEqual(0);
    return index;
  };
  const bake = steps.find((step) => step.uses?.startsWith('docker/bake-action@'))!;

  it('builds every application image under its commit, from the shared cache', () => {
    expect(publish.env).toMatchObject({
      FOC_IMAGE_TAG: 'sha-${{ github.sha }}',
      REGISTRY,
      APPLICATIONS: APPLICATION.join(' '),
    });
    expect(bake.with!.files!.split('\n').filter(Boolean)).toEqual([
      'compose.yaml',
      'compose.images.yaml',
    ]);
    expect(bake.with!.targets!.split('\n').filter(Boolean)).toEqual(APPLICATION);
    const set = bake.with!.set!.split('\n').map((line) => line.trim());
    for (const application of APPLICATION) {
      expect(set).toContain(`${application}.cache-from=type=gha,scope=${application}`);
      expect(set).toContain(`${application}.cache-to=type=gha,mode=max,scope=${application}`);
    }
  });

  it('pushes only the images it built and scanned, every one of them, whatever changed', () => {
    // Loaded into Docker, not pushed by the build: the push below sends exactly what was scanned.
    expect(String(bake.with!.load)).toBe('true');
    expect(bake.with!.push).toBeUndefined();
    const built = steps.indexOf(bake);
    const database = at((s) => s.uses === './.github/actions/trivy-db', 'the Trivy database');
    const scan = at(
      (s) => /scripts-scan-vulnerabilities\.sh --image/.test(s.run ?? ''),
      'the scan',
    );
    const push = at((s) => /docker push/.test(s.run ?? ''), 'the push');
    expect(steps[scan]!.run).toContain('$APPLICATIONS');
    expect(steps[push]!.run).toContain('$APPLICATIONS');
    expect(built).toBeLessThan(scan);
    expect(database).toBeLessThan(scan);
    expect(scan).toBeLessThan(push);
  });

  it('moves main only while its commit is still the newest on main', () => {
    const push = at((s) => /docker push/.test(s.run ?? ''), 'the push');
    const main = at((s) => /:main/.test(s.run ?? ''), 'the main tag');
    expect(push).toBeLessThan(main);
    expect(steps[main]!.run).toContain('git ls-remote origin refs/heads/main');
    expect(steps[main]!.run).toContain('$GITHUB_SHA');
    expect(bake.with!.set).not.toContain(':main');
  });

  it('labels the web app’s image as one for the local stack', () => {
    const set = bake.with!.set!.split('\n').map((line) => line.trim());
    const label = set.find((line) =>
      line.startsWith('web-app.labels.org.opencontainers.image.description='),
    );
    expect(label).toMatch(/local stack/);
  });

  it('gives every run but a pull request’s a group of its own, so none is dropped while it waits', () => {
    // GitHub keeps one pending run per group, so a shared group would drop a merged commit's run.
    expect(workflow.concurrency.group).toContain(
      'github.event.pull_request.number || github.run_id',
    );
    expect(String(workflow.concurrency['cancel-in-progress'])).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });
});
