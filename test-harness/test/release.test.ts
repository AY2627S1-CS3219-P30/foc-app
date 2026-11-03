import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * REL-03 (#169) — cutting a release: scripts-release.sh in a real Git repository, with `docker`
 * and `gh` replaced by stand-ins. The registry is a file of `reference=digest` lines, answered as
 * `docker buildx imagetools` answers, so the tests see which images a tag reaches and that nothing
 * is built.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const REGISTRY = 'registry.test/foc';

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}
const workflow = (path: string) =>
  yaml.load(readFileSync(join(ROOT, path), 'utf8')) as unknown as Workflow;

/** The six images CI publishes: what the script must tag, read from the job that pushes them. */
const APPLICATIONS = workflow('.github/workflows/ci.yml').jobs.publish!.env!.APPLICATIONS!.split(
  ' ',
);

const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
[[ "$1 $2" == "buildx imagetools" ]] || { echo "unexpected: docker $*" >&2; exit 64; }
if [[ "$3" == "inspect" ]]; then
  found="$(awk -F= -v ref="$4" '$1 == ref { value = $2 } END { print value }' "$FAKE_IMAGES")"
  case "$found" in
    "") echo "ERROR: $4: not found" >&2; exit 1 ;;
    broken) echo "ERROR: failed to do request: connection refused" >&2; exit 1 ;;
  esac
  printf '{"schemaVersion":2,"digest":"%s"}\\n' "$found"
elif [[ "$3" == "create" ]]; then
  # As buildx does: one image manifest is wrapped in a new index, under a new digest, unless it is
  # told to copy it as it is.
  shift 3
  wrapped="-wrapped"
  if [[ "$1" == "--prefer-index=false" ]]; then wrapped=""; shift; fi
  [[ "$1" == "--tag" ]] || { echo "unexpected: create $*" >&2; exit 64; }
  echo "$2=\${FAKE_RETAGGED_AS:-\${3##*@}$wrapped}" >> "$FAKE_IMAGES"
else
  echo "unexpected: docker $*" >&2; exit 64
fi
`;
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
prev=""
for arg in "$@"; do
  [[ "$prev" == "--notes-file" ]] && cp "$arg" "$FAKE_NOTES"
  prev="$arg"
done
exit 0
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();

const digestOf = (application: string) => `sha256:${application}`;
const image = (application: string, tag: string) => `${REGISTRY}/foc-${application}:${tag}`;

interface Options {
  /** Tag a commit that never reached main. */
  offMain?: boolean;
  /** Leave the tag uncreated. */
  untagged?: boolean;
  /** Edits the registry's lines, given the commit; by default every image is published. */
  registry?: (lines: string[], commit: string) => string[];
  env?: Record<string, string>;
}

function cut(tag: string, options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'foc-release-'));
  dirs.push(dir);
  copyFileSync(join(ROOT, 'scripts-release.sh'), join(dir, 'scripts-release.sh'));
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'on main');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (options.offMain) git(dir, 'commit', '-q', '--allow-empty', '-m', 'never merged');
  const commit = git(dir, 'rev-parse', 'HEAD');
  if (!options.untagged) spawnSync('git', ['tag', tag], { cwd: dir });

  const bin = join(dir, '.bin');
  execFileSync('mkdir', [bin]);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);

  const published = APPLICATIONS.map((a) => `${image(a, `sha-${commit}`)}=${digestOf(a)}`);
  const lines = options.registry?.(published, commit) ?? published;
  const images = join(dir, '.images');
  writeFileSync(images, lines.map((line) => `${line}\n`).join(''));

  const log = join(dir, '.docker-log');
  const ghLog = join(dir, '.gh-log');
  const notes = join(dir, '.notes');
  const run = spawnSync('bash', [join(dir, 'scripts-release.sh'), tag], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      REGISTRY,
      FAKE_LOG: log,
      FAKE_GH_LOG: ghLog,
      FAKE_NOTES: notes,
      FAKE_IMAGES: images,
      ...options.env,
    },
  });
  const linesOf = (path: string) =>
    existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
  return {
    commit,
    status: run.status,
    output: run.stdout + run.stderr,
    docker: linesOf(log),
    created: linesOf(log).filter((call) => call.includes(' create ')),
    gh: linesOf(ghLog),
    registry: Object.fromEntries(
      linesOf(images).map((line) => line.split('=') as [string, string]),
    ),
    notes: existsSync(notes) ? readFileSync(notes, 'utf8') : '',
  };
}

describe('cutting a release', () => {
  it('gives every published image the tag, under the digest CI scanned', () => {
    const { status, registry, output } = cut('rc1-d4');
    expect(output).toContain('rc1-d4');
    expect(status).toBe(0);
    for (const application of APPLICATIONS) {
      expect(registry[image(application, 'rc1-d4')], application).toBe(digestOf(application));
    }
  });

  it('tags by digest and builds, pulls and pushes nothing', () => {
    const { docker, created } = cut('rc1-d4');
    expect(created).toHaveLength(APPLICATIONS.length);
    for (const application of APPLICATIONS) {
      expect(created, application).toContain(
        `buildx imagetools create --prefer-index=false --tag ${image(application, 'rc1-d4')} ${REGISTRY}/foc-${application}@${digestOf(application)}`,
      );
    }
    expect(docker.every((call) => call.startsWith('buildx imagetools '))).toBe(true);
  });

  it('records the commit and every digest in a pre-release, for a release candidate', () => {
    const { gh, notes, commit } = cut('rc2-d4');
    expect(gh).toHaveLength(1);
    expect(gh[0]).toContain('release create rc2-d4 --verify-tag');
    expect(gh[0]).toContain('--prerelease');
    expect(gh[0]).toContain('Release candidate 2');
    expect(notes).toContain(commit);
    for (const application of APPLICATIONS) {
      expect(notes, application).toContain(image(application, 'rc2-d4'));
      expect(notes, application).toContain(digestOf(application));
    }
  });

  it('makes the final tag a full release', () => {
    const { gh, status } = cut('v1.0-d4');
    expect(status).toBe(0);
    expect(gh[0]).toContain('release create v1.0-d4 --verify-tag');
    expect(gh[0]).not.toContain('--prerelease');
  });

  it('says how to start these images, and how to roll back to them', () => {
    const { notes, commit } = cut('rc1-d4');
    expect(notes).toContain('git checkout rc1-d4');
    expect(notes).toContain(
      'FOC_IMAGE_TAG=rc1-d4 docker compose -f compose.yaml -f compose.images.yaml up -d --no-build',
    );
    expect(notes).toContain(`./scripts-rollback.sh sha-${commit} --additive-migrations-reviewed`);
  });

  it.each(['main', 'rc1', 'rc-d4', 'v1-d4', 'sha-abc', 'rc1-d4; rm -rf /', ''])(
    'refuses %j, which is not a release tag, before touching the registry',
    (tag) => {
      const { status, docker, gh, output } = cut(tag, { untagged: true });
      expect(status).toBe(2);
      expect(output).toContain('rc1-d4');
      expect(docker).toEqual([]);
      expect(gh).toEqual([]);
    },
  );

  it('refuses a tag that does not exist in this checkout', () => {
    const { status, docker, output } = cut('rc1-d4', { untagged: true });
    expect(status).toBe(1);
    expect(output).toContain('rc1-d4');
    expect(docker).toEqual([]);
  });

  it('refuses a commit that never reached main, whose images CI never scanned', () => {
    const { status, created, gh, output } = cut('rc1-d4', { offMain: true });
    expect(status).toBe(1);
    expect(output).toContain('not on main');
    expect(created).toEqual([]);
    expect(gh).toEqual([]);
  });

  it('tags nothing when one image is not published yet, and says to run it again', () => {
    const { status, created, gh, output } = cut('rc1-d4', {
      registry: (lines) => lines.filter((line) => !line.includes('foc-order-service')),
    });
    expect(status).toBe(1);
    expect(output).toContain('foc-order-service');
    expect(output).toContain('not found');
    expect(output).toMatch(/run .*again/i);
    expect(created).toEqual([]);
    expect(gh).toEqual([]);
  });

  it('never moves a release tag that already names other images', () => {
    const { status, created, gh, output } = cut('rc1-d4', {
      registry: (lines) => [...lines, `${image('web-app', 'rc1-d4')}=sha256:another-build`],
    });
    expect(status).toBe(1);
    expect(output).toContain('foc-web-app');
    expect(output).toContain('sha256:another-build');
    expect(created).toEqual([]);
    expect(gh).toEqual([]);
  });

  it('runs again over a tag that already names the same images, as after a failed run', () => {
    const { status, gh } = cut('rc1-d4', {
      registry: (lines) => [...lines, `${image('web-app', 'rc1-d4')}=${digestOf('web-app')}`],
    });
    expect(status).toBe(0);
    expect(gh).toHaveLength(1);
  });

  it('stops rather than overwrite when it cannot tell what a release tag names', () => {
    const { status, created, gh, output } = cut('rc1-d4', {
      registry: (lines) => [...lines, `${image('web-app', 'rc1-d4')}=broken`],
    });
    expect(status).toBe(1);
    expect(output).toContain('connection refused');
    expect(created).toEqual([]);
    expect(gh).toEqual([]);
  });

  it('records nothing when a tagged image comes back with another digest', () => {
    const { status, gh, output } = cut('rc1-d4', { env: { FAKE_RETAGGED_AS: 'sha256:rewritten' } });
    expect(status).toBe(1);
    expect(output).toContain('sha256:rewritten');
    expect(gh).toEqual([]);
  });
});

describe('the release workflow', () => {
  const release = workflow('.github/workflows/release.yml');
  const job = release.jobs.release!;
  const runs = job.steps.map((step) => step.run ?? '').join('\n');

  it('runs only when a release tag is pushed', () => {
    expect(release.on).toEqual({ push: { tags: ['rc[0-9]+-d4', 'v[0-9]+.[0-9]+-d4'] } });
  });

  it('may write only the Release and the images’ tags', () => {
    expect(release.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: 'write', packages: 'write' });
  });

  it('runs the script on the tag, with the history it checks main against', () => {
    expect(runs).toContain('./scripts-release.sh "$GITHUB_REF_NAME"');
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with).toMatchObject({ 'fetch-depth': 0 });
    const script = job.steps.find((step) => step.run?.includes('scripts-release.sh'))!;
    expect(script.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
  });

  it('signs in to the registry before the script, and never builds', () => {
    const steps = job.steps;
    const login = steps.findIndex((step) => step.uses?.startsWith('docker/login-action@'));
    const script = steps.findIndex((step) => step.run?.includes('scripts-release.sh'));
    expect(login).toBeGreaterThanOrEqual(0);
    expect(login).toBeLessThan(script);
    for (const step of steps) {
      expect(step.uses ?? '').not.toMatch(/bake-action|build-push-action/);
      expect(step.run ?? '').not.toMatch(/docker (build|push)/);
    }
  });

  it('does not run CI on a tag, which would build and publish the images a second time', () => {
    const ci = workflow('.github/workflows/ci.yml');
    expect((ci.on as { push?: { tags?: unknown } }).push?.tags).toBeUndefined();
  });
});
