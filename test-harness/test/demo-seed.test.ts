import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts-seed-demo.py', import.meta.url));
const wrapper = fileURLToPath(new URL('../../scripts-seed-demo.sh', import.meta.url));
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
const python = (program: string) =>
  spawnSync(
    'python3',
    [
      '-c',
      `
import importlib.util,sys
spec=importlib.util.spec_from_file_location('demo_seed',sys.argv[1])
demo=importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)
${program}
`,
      script,
    ],
    { encoding: 'utf8' },
  );

describe('D4 seed boundaries and private credentials', () => {
  it('excludes credentials, browser sessions and recovery dumps from the image build context', () => {
    const ignored = readFileSync(
      fileURLToPath(new URL('../../.dockerignore', import.meta.url)),
      'utf8',
    ).split('\n');
    for (const directory of ['.demo-state', 'backups', '.recovery-results']) {
      expect(ignored).toContain(directory);
    }
  });
  it('refuses remote targets and direct production/default-project invocation before any API call', () => {
    const result = python(`
for edge in ['https://localhost:14000','http://example.com','http://localhost.example.com']:
    try: demo.Api(edge)
    except ValueError: pass
    else: raise AssertionError('accepted remote target')
demo.Api('http://localhost:14000')
`);
    expect(result.status, result.stderr).toBe(0);
    const direct = spawnSync('python3', [script, '--up'], {
      env: { ...process.env, NODE_ENV: 'production', COMPOSE_PROJECT_NAME: 'foc' },
      encoding: 'utf8',
    });
    expect(direct.status).toBe(1);
    expect(direct.stderr).toContain('isolated development wrapper');
  });

  it('stores unique per-persona secrets privately and preserves them across reruns', () => {
    const result = python(`
import tempfile,pathlib,stat,json
with tempfile.TemporaryDirectory() as folder:
    demo.STATE=pathlib.Path(folder)
    first=demo.credentials('u.nus.edu',True)
    assert len(first)==5
    assert len({p['password'] for p in first.values()})==5
    assert first==demo.credentials('u.nus.edu',True)
    assert stat.S_IMODE((demo.STATE/'credentials.json').stat().st_mode)==0o600
    try: demo.credentials('nus.edu',True)
    except ValueError: pass
    else: raise AssertionError('overwrote another domain credentials')
    assert json.loads((demo.STATE/'credentials.json').read_text())['personas']==first
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('rejects invalid commands/ports without initializing env or invoking Docker', () => {
    const existed = existsSync(envPath);
    for (const [args, port] of [
      [['--invalid'], '14000'],
      [['--fresh'], 'bad'],
      [['--fresh'], '65530'],
    ] as const) {
      const result = spawnSync('bash', [wrapper, ...args], {
        env: { ...process.env, D4_PORT_BASE: port },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(2);
    }
    expect(existsSync(envPath)).toBe(existed);
  });

  it('accepts a real zero-credit wallet without issuing or repairing credits during a check', () => {
    const result = python(`
class Api:
    def call(self,method,path,*args,**kwargs):
        if (method,path)==('POST','/api/user/auth/login'):
            return {'accessToken':'fixture-token','user':{'roles':['STUDENT']}}
        if (method,path)==('GET','/api/user/users/me'):
            return {'id':'student','status':'ACTIVE','profile':{'displayName':'Alyssa Tan'}}
        if (method,path)==('GET','/api/credit/wallets/me'):
            return {'userId':'student','available':0,'reserved':0,'total':0}
        raise AssertionError('unexpected mutation or repair')
def no_wait(_): raise AssertionError('a valid zero wallet must not wait for a top-up')
demo.time.sleep=no_wait
person={'name':'Alyssa Tan','email':'fixture@u.nus.edu','password':'unused-fixture'}
token,me=demo.ensure_person(Api(),'requester',person,False)
assert token=='fixture-token' and me['id']=='student'
`);
    expect(result.status, result.stderr).toBe(0);
  });
});

/**
 * #169: a rehearsal has to run the images a release names, or it proves nothing about them. The
 * script runs in a directory of its own with `docker` replaced, so the tests see each command and
 * the Compose files and tag it ran with, and the real `.demo-state` is left alone.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s|%s|%s\\n' "$COMPOSE_FILE" "\${FOC_IMAGE_TAG-unset}" "$*" >> "$FAKE_LOG"
case "$*" in
  'compose port edge 8080') echo "127.0.0.1:$WEB_APP_PORT" ;;
  'compose pull'*) [[ -z "\${FAKE_PULL_FAILS:-}" ]] ;;
esac
`;
const BOTH_FILES = 'compose.yaml:compose.images.yaml';

describe("the D4 demo on a release's images", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function stage() {
    const dir = mkdtempSync(join(tmpdir(), 'foc-demo-images-'));
    dirs.push(dir);
    copyFileSync(wrapper, join(dir, 'scripts-seed-demo.sh'));
    copyFileSync(new URL('../../scripts-env.sh', import.meta.url), join(dir, 'scripts-env.sh'));
    writeFileSync(join(dir, 'scripts-init-env.sh'), '#!/usr/bin/env bash\n');
    chmodSync(join(dir, 'scripts-init-env.sh'), 0o755);
    writeFileSync(join(dir, 'scripts-seed-demo.py'), "open('.seeded', 'a').write('seeded\\n')\n");
    writeFileSync(join(dir, '.env'), 'ALLOWED_EMAIL_DOMAINS=u.nus.edu\n');
    mkdirSync(join(dir, '.bin'));
    writeFileSync(join(dir, '.bin/docker'), FAKE_DOCKER);
    chmodSync(join(dir, '.bin/docker'), 0o755);
    return dir;
  }

  function run(dir: string, action: string, env: Record<string, string> = {}) {
    const log = join(dir, '.docker-log');
    rmSync(log, { force: true });
    const inherited = { ...process.env };
    delete inherited.FOC_IMAGE_TAG;
    const result = spawnSync('bash', [join(dir, 'scripts-seed-demo.sh'), action], {
      encoding: 'utf8',
      env: {
        ...inherited,
        PATH: `${join(dir, '.bin')}:${process.env.PATH}`,
        FAKE_LOG: log,
        ...env,
      },
    });
    const calls = existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => {
            const [files, tag, command] = line.split('|');
            return { files, tag, command };
          })
      : [];
    return { ...result, calls, commands: calls.map((call) => call.command) };
  }

  const context = (dir: string) =>
    spawnSync(
      'bash',
      [
        '-c',
        '. ./.demo-state/foc-d4-demo/ports.sh; printf "%s|%s" "$COMPOSE_FILE" "$FOC_IMAGE_TAG"',
      ],
      { cwd: dir, encoding: 'utf8' },
    ).stdout;

  const applications = () => {
    const overlay = yaml.load(
      readFileSync(new URL('../../compose.images.yaml', import.meta.url), 'utf8'),
    ) as { services: Record<string, unknown> };
    return Object.keys(overlay.services).filter((name) => !name.endsWith('-migrate'));
  };

  it('builds this checkout when no tag is named, as the CI seed run does', () => {
    const dir = stage();
    const result = run(dir, '--fresh');
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([
      'compose down -v',
      'compose up -d --build --wait',
      'compose port edge 8080',
    ]);
    expect(result.calls.every((call) => call.files === 'compose.yaml')).toBe(true);
    expect(result.stdout).toContain('Demo images: built from this checkout');
  });

  it("runs a release's images and builds nothing", () => {
    const dir = stage();
    const result = run(dir, '--fresh', { FOC_IMAGE_TAG: 'rc1-d4' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toEqual([
      `compose pull --policy missing ${applications().join(' ')}`,
      'compose down -v',
      'compose up -d --no-build --wait',
      'compose port edge 8080',
    ]);
    expect(result.calls.every((call) => call.files === BOTH_FILES && call.tag === 'rc1-d4')).toBe(
      true,
    );
    expect(result.stdout).toContain('Demo images: rc1-d4');
  });

  it('deletes nothing and records nothing for a tag it cannot pull', () => {
    const dir = stage();
    expect(run(dir, '--fresh', { FOC_IMAGE_TAG: 'rc1-d4' }).status).toBe(0);
    for (const action of ['--fresh', '--up']) {
      const result = run(dir, action, { FOC_IMAGE_TAG: 'rc9-d4', FAKE_PULL_FAILS: '1' });
      expect(result.status).not.toBe(0);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toContain('compose pull');
      expect(context(dir)).toBe(`${BOTH_FILES}|rc1-d4`);
    }
    expect(readFileSync(join(dir, '.seeded'), 'utf8')).toBe('seeded\n');
  });

  it('keeps a stack on its images without naming them again, so a recovery cannot swap them', () => {
    const dir = stage();
    expect(run(dir, '--fresh', { FOC_IMAGE_TAG: 'rc1-d4' }).status).toBe(0);
    for (const action of ['--up', '--check', '--stop', '--fresh']) {
      const result = run(dir, action);
      expect(result.status, result.stderr).toBe(0);
      expect(result.commands.join('\n')).not.toContain('--build');
      expect(result.calls.every((call) => call.files === BOTH_FILES && call.tag === 'rc1-d4')).toBe(
        true,
      );
      expect(context(dir)).toBe(`${BOTH_FILES}|rc1-d4`);
    }
  });

  it('moves to another release when --up or --fresh names one', () => {
    const dir = stage();
    expect(run(dir, '--fresh', { FOC_IMAGE_TAG: 'rc1-d4' }).status).toBe(0);
    const result = run(dir, '--up', { FOC_IMAGE_TAG: 'rc2-d4' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.every((call) => call.tag === 'rc2-d4')).toBe(true);
    expect(context(dir)).toBe(`${BOTH_FILES}|rc2-d4`);
  });

  it('ignores a tag on --check and --stop, which start nothing', () => {
    const dir = stage();
    expect(run(dir, '--fresh', { FOC_IMAGE_TAG: 'rc1-d4' }).status).toBe(0);
    for (const action of ['--check', '--stop']) {
      const result = run(dir, action, { FOC_IMAGE_TAG: 'rc2-d4' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.commands.join('\n')).not.toContain('pull');
      expect(context(dir)).toBe(`${BOTH_FILES}|rc1-d4`);
    }
  });

  it('goes back to building this checkout when the tag is set empty', () => {
    const dir = stage();
    expect(run(dir, '--fresh', { FOC_IMAGE_TAG: 'rc1-d4' }).status).toBe(0);
    const result = run(dir, '--fresh', { FOC_IMAGE_TAG: '' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toContain('compose up -d --build --wait');
    expect(result.commands.join('\n')).not.toContain('pull');
    expect(context(dir)).toBe('compose.yaml|');
    expect(result.stdout).toContain('Demo images: built from this checkout');
  });

  it('refuses a tag Docker could not name before it touches anything', () => {
    const dir = stage();
    for (const tag of ['rc1 d4', '-rc1', 'rc1:d4', 'a'.repeat(129)]) {
      const result = run(dir, '--fresh', { FOC_IMAGE_TAG: tag });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('FOC_IMAGE_TAG');
      expect(result.commands).toEqual([]);
    }
    expect(existsSync(join(dir, '.demo-state'))).toBe(false);
  });
});
