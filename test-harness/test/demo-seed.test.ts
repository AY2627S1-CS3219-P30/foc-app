import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
});
