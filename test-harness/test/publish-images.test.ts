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

interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps?: Array<{ uses?: string; with?: Record<string, string> }>;
}
const workflow = yaml.load(read('.github/workflows/ci.yml')) as {
  permissions: Record<string, string>;
  concurrency: { 'cancel-in-progress': string | boolean };
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

  it('pushes every application image under its commit and as main, from the shared cache', () => {
    const bake = publish.steps!.find((step) => step.uses?.startsWith('docker/bake-action@'))!;
    expect(bake.with!.files!.split('\n').filter(Boolean)).toEqual([
      'compose.yaml',
      'compose.images.yaml',
    ]);
    expect(bake.with!.targets!.split('\n').filter(Boolean)).toEqual(APPLICATION);
    expect(String(bake.with!.push)).toBe('true');
    const set = bake.with!.set!.split('\n').map((line) => line.trim());
    for (const application of APPLICATION) {
      expect(set).toContain(`${application}.tags+=${REGISTRY}/foc-${application}:main`);
      expect(set).toContain(`${application}.cache-from=type=gha,scope=${application}`);
      expect(set).toContain(`${application}.cache-to=type=gha,mode=max,scope=${application}`);
    }
  });

  it('is not cancelled by the next push to main, so every merged commit is published', () => {
    expect(String(workflow.concurrency['cancel-in-progress'])).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });
});
