import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * PLT-06 — what the committed deployment files must not contain, and must say.
 *
 * These read `compose.yaml`, `.env.example` and the scripts beside them as text or YAML, so they
 * fail in the Node job, before anything is built, if a credential or a fallback for one comes
 * back. What only a running stack can show (who a container runs as, what the broker refuses) is
 * checked by `scripts-smoke.sh` and `scripts-restart-check.sh`.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** A variable that holds a credential, by its name. */
const SECRET_NAME = /(PASSWORD|KEY|KEYS|TOKEN|SECRET)$/;

/** `NAME=value` lines of an env file, including examples left in comments (`# NAME=value`). */
const assignments = (text: string) =>
  [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/gm)].map(([, name, value]) => ({
    name: name!,
    value: value!.trim(),
  }));

describe('secrets stay out of source (PL-NFR2.1.1)', () => {
  const compose = read('compose.yaml');

  it('compose.yaml has no fallback for a secret', () => {
    const fallbacks = [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*):?-[^}]*\}/g)]
      .map(([, name]) => name!)
      .filter((name) => SECRET_NAME.test(name));
    expect(fallbacks).toEqual([]);
  });

  it.each(['compose.yaml', '.github/workflows/ci.yml', 'package.json'])(
    '%s has no credential written into a URL',
    (file) => {
      // scheme://user:password@host, where the password is not taken from a variable. Either
      // part may be a ${VARIABLE}, whose own text can hold a colon.
      const part = String.raw`(?:\$\{[^}]*\}|[^\s:/@'"])+`;
      const userinfo = new RegExp(String.raw`[a-z][a-z0-9+]*:\/\/${part}:(${part})@`, 'g');
      const literal = [...read(file).matchAll(userinfo)]
        .map(([, password]) => password!)
        .filter((password) => !password.startsWith('$'));
      expect(literal).toEqual([]);
    },
  );

  it('.env.example gives no value for a secret', () => {
    const valued = assignments(read('.env.example'))
      .filter(({ name }) => SECRET_NAME.test(name))
      // A secret is generated, derived from generated ones, or shown as a <placeholder>.
      .filter(({ value }) => value !== '' && !/^<[^>]+>$/.test(value))
      .map(({ name }) => name);
    expect(valued).toEqual([]);
  });

  it('no database role password is written in an init file', () => {
    const init = readdirSync(ROOT).filter((name) => /^postgres-init\./.test(name));
    expect(init.length).toBeGreaterThan(0);
    for (const file of init) expect(read(file)).not.toMatch(/PASSWORD\s+'[^']/i);
  });

  it('every secret compose.yaml needs is one scripts-init-env.sh generates', () => {
    const required = [
      ...new Set(
        [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)]
          .map(([, name]) => name!)
          .filter((name) => SECRET_NAME.test(name)),
      ),
    ];
    const generated = new Set(
      assignments(read('.env.example'))
        .filter(({ value }) => /^<(generated|from:)/.test(value))
        .map(({ name }) => name),
    );
    expect(required.length).toBeGreaterThan(10);
    expect(required.filter((name) => !generated.has(name))).toEqual([]);
  });

  it('no tracked file mentions a retired development credential', () => {
    // Built from parts so this file does not match itself.
    const retired = new RegExp(
      [
        ['foc', 'dev'].join('_'),
        ['postgres', 'dev'].join('_'),
        ['_service', 'dev'].join('_'),
        ['grafana', 'dev'].join('_'),
        ['dev-only-', '[a-z-]+', '-change-me'].join(''),
      ].join('|'),
    );
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((file) => file && existsSync(join(ROOT, file)))
      .filter(
        (file) => !/(package-lock\.json|bun\.lock|\.(png|jpg|ico|docx|pdf|woff2?))$/.test(file),
      );
    const offenders = tracked.filter((file) => retired.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('the build context leaves .env out, so it cannot be copied into an image', () => {
    const ignored = read('.dockerignore').split('\n');
    expect(ignored).toContain('.env');
    expect(ignored).toContain('.env.*');
  });
});

interface ComposeService {
  image?: string;
  user?: string;
  hostname?: string;
  read_only?: boolean;
  entrypoint?: string[];
  environment?: Record<string, string>;
  ports?: string[];
  networks?: string[];
  volumes?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  healthcheck?: { test: string[] };
  build?: unknown;
}
/** compose.yaml as Compose reads it, anchors merged; `${...}` references are left as written. */
const services = (yaml.load(read('compose.yaml')) as { services: Record<string, ComposeService> })
  .services;
const APPLICATION = [
  'user-service',
  'supplier-service',
  'order-service',
  'credit-service',
] as const;

describe('one broker account per service (PLT-06)', () => {
  it('gives each service its own broker login, and none the operator’s', () => {
    for (const name of APPLICATION) {
      const variable = `${name.split('-')[0]!.toUpperCase()}_BROKER_PASSWORD`;
      const url = services[name]!.environment!.RABBITMQ_URL!;
      expect(url, name).toMatch(
        new RegExp(String.raw`^amqp://${name}:\$\{${variable}:\?[^}]*\}@rabbitmq:5672$`),
      );
    }
    const usesOperator = Object.entries(services)
      .filter(([name]) => name !== 'rabbitmq')
      .filter(([, service]) => /RABBITMQ_(USER|PASSWORD)/.test(JSON.stringify(service)))
      .map(([name]) => name);
    expect(usesOperator).toEqual([]);
  });

  it('creates the accounts when the broker starts, and is healthy only once they exist', () => {
    const broker = services.rabbitmq!;
    expect(broker.entrypoint?.join(' ')).toContain('rabbitmq-init.sh');
    expect(broker.volumes?.some((v) => v.startsWith('./rabbitmq-init.sh:'))).toBe(true);
    expect(broker.healthcheck!.test.join(' ')).toContain('foc-broker-accounts-ready');
    for (const prefix of ['USER', 'SUPPLIER', 'ORDER', 'CREDIT']) {
      expect(broker.environment).toHaveProperty(`${prefix}_BROKER_PASSWORD`);
    }
  });

  it('keeps the broker’s messages when its container is recreated', () => {
    // RabbitMQ files its data under its host name; a new container gets a new one unless fixed.
    expect(services.rabbitmq!.hostname).toBe('rabbitmq');
    expect(services.rabbitmq!.volumes).toContain('rabbitmq-data:/var/lib/rabbitmq');
  });

  it('limits each account to its own routing keys and queues', () => {
    const script = read('rabbitmq-init.sh');
    // The default exchange reaches every queue by name, so no service account may write to it.
    expect(script).not.toMatch(/amq\\?\.default/);
    for (const [name, short] of [
      ['user-service', 'user'],
      ['supplier-service', 'supplier'],
      ['order-service', 'order'],
      ['credit-service', 'credit'],
    ]) {
      expect(script, name).toMatch(new RegExp(String.raw`account ${name} \S+ ${short} `));
    }
  });
});

describe('containers get only what they need (PL-NFR2.1.2)', () => {
  const MIGRATIONS = APPLICATION.map((name) => `${name}-migrate`);

  it('puts no service on a network it has no dependency on', () => {
    const joined = Object.fromEntries(
      Object.entries(services).map(([name, service]) => [
        name,
        [...(service.networks ?? [])].sort(),
      ]),
    );
    expect(joined).toEqual({
      postgres: ['db', 'local'],
      rabbitmq: ['broker', 'local'],
      ...Object.fromEntries(MIGRATIONS.map((name) => [name, ['db']])),
      ...Object.fromEntries(
        APPLICATION.map((name) => [name, ['broker', 'db', 'gateway', 'public', 'services']]),
      ),
      // Reached only through the edge, on a network the two share; the web app's container calls
      // nothing, so it reaches no service, internal port or public (PLT-13).
      'web-app': ['web'],
      // Its own way out, for the one published port, and the internal networks to what it routes to.
      edge: ['edge', 'gateway', 'web'],
      prometheus: ['broker', 'observability', 'services'],
      grafana: ['observability'],
    });
  });

  it('gives a container that publishes a port exactly one network with a way out', () => {
    // With two, Docker may publish the port on one and route replies out of the other, and the
    // port never answers from the host. The networks containers talk on are internal.
    const networks = (
      yaml.load(read('compose.yaml')) as { networks: Record<string, { internal?: boolean } | null> }
    ).networks;
    const internal = (name: string) => networks[name]?.internal === true;
    expect(['db', 'broker', 'services', 'gateway'].filter((name) => !internal(name))).toEqual([]);
    for (const [name, service] of Object.entries(services)) {
      const outward = (service.networks ?? []).filter((network) => !internal(network));
      expect(outward, name).toHaveLength(service.ports?.length ? 1 : 0);
    }
  });

  it('publishes the data stores on this machine only', () => {
    const published = [...services.postgres!.ports!, ...services.rabbitmq!.ports!];
    expect(published).toHaveLength(3);
    for (const port of published) expect(port).toMatch(/^127\.0\.0\.1:/);
  });

  it('gives each service an internal port that is not published, and points callers at it', () => {
    APPLICATION.forEach((name, i) => {
      const service = services[name]!;
      const internal = String(4001 + i);
      expect(String(service.environment!.INTERNAL_PORT), name).toBe(internal);
      expect(service.ports, name).toHaveLength(1);
      expect(service.ports![0], name).not.toContain(internal);
    });
    // Introspection and Credit's status are /internal/** routes: reachable on that port only.
    for (const caller of ['supplier-service', 'order-service', 'credit-service']) {
      expect(services[caller]!.environment!.USER_SERVICE_URL).toBe('http://user-service:4001');
    }
    expect(services['order-service']!.environment!.CREDIT_SERVICE_URL).toBe(
      'http://credit-service:4004',
    );
  });

  it('publishes an internal port only in the development override, and there only to this machine', () => {
    const override = (
      yaml.load(read('compose.dev.yaml')) as { services: Record<string, ComposeService> }
    ).services;
    expect(Object.keys(override).sort()).toEqual([...APPLICATION].sort());
    APPLICATION.forEach((name, i) => {
      const internal = 4001 + i;
      expect(override[name], name).toEqual({ ports: [`127.0.0.1:${internal}:${internal}`] });
    });
  });

  it('drops every capability from the application containers and lets none be regained', () => {
    for (const name of [...APPLICATION, ...MIGRATIONS, 'web-app', 'edge']) {
      expect(services[name]!.cap_drop, name).toEqual(['ALL']);
      expect(services[name]!.security_opt, name).toEqual(['no-new-privileges:true']);
    }
  });

  it('runs the application images as an unprivileged user', () => {
    for (const dir of [...APPLICATION, 'web-app']) {
      const lines = read(`${dir}/Dockerfile`).split('\n');
      const lastUser = lines.filter((line) => /^USER\s/.test(line)).at(-1);
      expect(lastUser, dir).toBe('USER node');
    }
  });
});

/**
 * PLT-10 (#285, ADR 0010) — one origin for the browser. The edge publishes the only port beyond
 * this machine and routes `/api/<service>/` to each service and everything else to the web app;
 * it never routes `/internal`. Read as text here; `scripts-smoke.sh` checks it on a running stack.
 */
describe('the edge (PLT-10)', () => {
  const edge = services.edge!;
  const nginx = read('edge/nginx.conf');
  const ROUTES = {
    user: 'user-service:3001',
    supplier: 'supplier-service:3002',
    order: 'order-service:3003',
    credit: 'credit-service:3004',
  };

  it('publishes the only port beyond this machine: every other is on 127.0.0.1', () => {
    expect(edge.ports).toEqual(['${WEB_APP_PORT:-3000}:8080']);
    for (const [name, service] of Object.entries(services)) {
      if (name === 'edge') continue;
      for (const port of service.ports ?? []) expect(port, name).toMatch(/^127\.0\.0\.1:/);
    }
  });

  it('is the only way to the web app, whose build calls the services through it', () => {
    expect(services['web-app']!.ports).toBeUndefined();
    const args = (services['web-app']!.build as { args: Record<string, string> }).args;
    expect(args).toMatchObject({
      NEXT_PUBLIC_USER_SERVICE_URL: '/api/user',
      NEXT_PUBLIC_SUPPLIER_SERVICE_URL: '/api/supplier',
      NEXT_PUBLIC_ORDER_SERVICE_URL: '/api/order',
      NEXT_PUBLIC_CREDIT_SERVICE_URL: '/api/credit',
    });
  });

  it('runs unprivileged, read-only, with a health check', () => {
    expect(edge.image).toMatch(/^nginxinc\/nginx-unprivileged:/);
    expect(edge.read_only).toBe(true);
    // Its health is the stack's readiness (PLT-13): see stack-readiness.test.ts.
    expect(JSON.stringify(edge.healthcheck)).toContain('/edge/ready');
  });

  it('routes each service under /api/<service>/, and the rest to the web app', () => {
    for (const [prefix, upstream] of Object.entries(ROUTES)) {
      const block = nginx.match(new RegExp(`location /api/${prefix}/ \\{([^}]*)\\}`))?.[1];
      expect(block, prefix).toContain(`set $upstream ${upstream};`);
      expect(block, prefix).toContain('proxy_pass http://$upstream$api_path;');
    }
    expect(nginx).toMatch(/location \/ \{[^}]*set \$upstream web-app:3000;/);
  });

  it('never routes the internal API or the metrics, however the path is spelled', () => {
    // Matched on nginx's normalised path, which a regex location checks before the prefixes, and
    // ignoring case, as the services' routes do.
    expect(nginx).toContain('location ~* ^/api/[a-z]+/(internal|metrics)(/|$) {');
  });

  it('sets the security headers on every response, and limits writes and request size', () => {
    for (const header of [
      'Content-Security-Policy',
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy',
    ]) {
      expect(read('edge/headers.conf')).toMatch(
        new RegExp(`^add_header ${header} .* always;$`, 'm'),
      );
    }
    expect(nginx).toMatch(/limit_req_zone \$write_client zone=writes:/);
    expect(nginx).toMatch(/^\s+limit_req zone=writes /m);
    expect(nginx).toMatch(/^\s+client_max_body_size \d+[km];$/m);
  });

  it('serves the refresh cookie on the path the browser now sends it to', () => {
    expect(nginx).toContain('proxy_cookie_path /auth /api/user/auth;');
  });

  it('passes the live-update stream on as it is written, and limits streams per address (N1.4)', () => {
    // An exact match, so it is chosen over the /api/order/ prefix (ADR 0011, #330).
    const block = nginx.match(/location = \/api\/order\/live \{([^}]*)\}/)?.[1];
    expect(block).toContain('set $upstream order-service:3003;');
    expect(block).toContain('proxy_pass http://$upstream$api_path;');
    expect(block).toContain('error_page 502 504 =503 @unavailable;');
    // Buffered, nudges would arrive in batches; a 20 s keep-alive may be missed twice.
    expect(block).toMatch(/^\s+proxy_buffering off;$/m);
    expect(block).toMatch(/^\s+proxy_read_timeout 90s;$/m);
    // At most 10 per address, refused like the service's own cap, so a page polls for a minute.
    expect(nginx).toMatch(/limit_conn_zone \$binary_remote_addr zone=streams:/);
    expect(block).toMatch(/^\s+limit_conn streams 10;$/m);
    expect(block).toMatch(/^\s+limit_conn_status 429;$/m);
    expect(block).toContain('error_page 429 = @too_many_streams;');
    const refusal = nginx.match(/location @too_many_streams \{([^}]*)\}/)?.[1];
    expect(refusal).toContain('add_header Retry-After 60 always;');
    expect(refusal).toContain('"code":"TOO_MANY_STREAMS"');
    // Each stream holds two of the edge's connections, browser and service.
    expect(nginx).toMatch(/^\s+worker_connections 4096;$/m);
  });

  it('tells each service the client’s address, which the service believes from the edge alone', () => {
    expect(nginx).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    for (const name of APPLICATION) {
      const env = services[name]!.environment as Record<string, unknown>;
      expect(env.TRUSTED_PROXY, name).toBe('edge');
      expect(env, name).not.toHaveProperty('TRUST_PROXY_HOPS');
    }
  });
});

describe('reproducible versions (D3 4.2)', () => {
  /** name:exact-version@sha256:digest — a tag alone can be moved to different content. */
  const PINNED = /^[a-z0-9./-]+:v?\d+\.\d+(\.\d+)?[a-z0-9.-]*@sha256:[0-9a-f]{64}$/;

  it('pins every image compose.yaml pulls to a version and a digest', () => {
    const images = Object.values(services)
      .map((service) => service.image)
      .filter((image): image is string => Boolean(image));
    expect(images).toHaveLength(5);
    for (const image of images) expect(image).toMatch(PINNED);
  });

  it('pins every base image the Dockerfiles build from', () => {
    for (const dir of [...APPLICATION, 'web-app']) {
      const stages = new Set<string>();
      for (const [, image, stage] of read(`${dir}/Dockerfile`).matchAll(
        /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim,
      )) {
        // A later stage may build on an earlier one by name; that is not a pull.
        if (!stages.has(image!)) expect(image, `${dir}: ${image}`).toMatch(PINNED);
        if (stage) stages.add(stage);
      }
    }
  });

  it('pulls no build frontend by a tag that can move', () => {
    for (const dir of [...APPLICATION, 'web-app']) {
      const syntax = read(`${dir}/Dockerfile`).match(/^#\s*syntax\s*=\s*(\S+)/m)?.[1];
      // None is needed: the builder's own frontend builds these files. One that is named is pinned.
      if (syntax) expect(syntax, dir).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it('pins the images the CI workflow runs', () => {
    const images = [...read('.github/workflows/ci.yml').matchAll(/^\s+image:\s+(\S+)/gm)].map(
      ([, image]) => image!,
    );
    expect(images.length).toBeGreaterThanOrEqual(3);
    for (const image of images) expect(image).toMatch(PINNED);
  });
});

describe('scripts-init-env.sh', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A copy of the script and the example in a directory of their own. */
  function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'foc-init-env-'));
    dirs.push(dir);
    copyFileSync(join(ROOT, 'scripts-init-env.sh'), join(dir, 'scripts-init-env.sh'));
    copyFileSync(join(ROOT, '.env.example'), join(dir, '.env.example'));
    const run = (...args: string[]) =>
      spawnSync('bash', [join(dir, 'scripts-init-env.sh'), ...args], { encoding: 'utf8' });
    const env = () =>
      Object.fromEntries(
        assignments(readFileSync(join(dir, '.env'), 'utf8').replace(/^#.*$/gm, '')).map(
          ({ name, value }) => [name, value],
        ),
      );
    return { dir, run, env };
  }

  it('creates .env with a value of its own for every secret, readable by the owner only', () => {
    const { dir, run, env } = sandbox();

    const result = run();

    expect(result.status).toBe(0);
    const values = env();
    const secrets = Object.entries(values).filter(([name]) => SECRET_NAME.test(name));
    expect(secrets.length).toBeGreaterThan(10);
    for (const [name, value] of secrets) {
      expect(value, name).not.toMatch(/^</);
      expect(value.length, name).toBeGreaterThanOrEqual(32);
    }
    // No two services, and no two accounts of one service, share a secret.
    const single = secrets.filter(([name]) => !name.endsWith('KEYS')).map(([, value]) => value);
    expect(new Set(single).size).toBe(single.length);
    expect(statSync(join(dir, '.env')).mode & 0o077).toBe(0);
    // It says what it did without showing a value.
    for (const value of single) expect(result.stdout + result.stderr).not.toContain(value);
  });

  it('generates a signing key the User Service can load', () => {
    const { run, env } = sandbox();
    run();
    const pem = Buffer.from(env().JWT_PRIVATE_KEY!, 'base64').toString('utf8');
    expect(pem).toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('gives the User Service every caller’s key, and Credit only the Order Service’s', () => {
    const { run, env } = sandbox();
    run();
    const v = env();
    expect(v.INTERNAL_SERVICE_KEYS).toBe(
      [v.SUPPLIER_INTERNAL_KEY, v.ORDER_INTERNAL_KEY, v.CREDIT_INTERNAL_KEY].join(','),
    );
    expect(v.CREDIT_INBOUND_SERVICE_KEYS).toBe(v.ORDER_INTERNAL_KEY);
  });

  it('adds what is missing and leaves existing values alone', () => {
    const { dir, run, env } = sandbox();
    writeFileSync(
      join(dir, '.env'),
      'POSTGRES_PASSWORD=kept-exactly-as-it-was-0123456789\nMY_OWN_SETTING=1\n',
    );

    expect(run().status).toBe(0);

    const values = env();
    expect(values.POSTGRES_PASSWORD).toBe('kept-exactly-as-it-was-0123456789');
    expect(values.MY_OWN_SETTING).toBe('1');
    expect(values.RABBITMQ_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
  });

  it('changes nothing when run again', () => {
    const { dir, run } = sandbox();
    run();
    const first = readFileSync(join(dir, '.env'), 'utf8');

    expect(run().status).toBe(0);

    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(first);
  });

  it('fills a placeholder left by copying .env.example by hand', () => {
    const { dir, run, env } = sandbox();
    copyFileSync(join(dir, '.env.example'), join(dir, '.env'));

    expect(run().status).toBe(0);

    expect(Object.values(env()).filter((value) => value.startsWith('<'))).toEqual([]);
  });

  it('does not call an .env from before this change complete: it names what is unsafe and changes nothing', () => {
    const { dir, run } = sandbox();
    run();
    // As a copy of the old example was: one key for all three callers, short passwords.
    const shared = 'one-key-that-every-service-used-to-share';
    const old = readFileSync(join(dir, '.env'), 'utf8')
      .replace(/^(SUPPLIER|ORDER|CREDIT)_INTERNAL_KEY=.*$/gm, `$1_INTERNAL_KEY=${shared}`)
      .replace(/^POSTGRES_PASSWORD=.*$/m, 'POSTGRES_PASSWORD=too_short')
      .replace(/^JWT_PRIVATE_KEY=.*$/m, 'JWT_PRIVATE_KEY=not-a-key');
    writeFileSync(join(dir, '.env'), old);

    for (const result of [run(), run('--check')]) {
      const said = result.stdout + result.stderr;
      expect(result.status).toBe(1);
      for (const name of [
        'SUPPLIER_INTERNAL_KEY',
        'ORDER_INTERNAL_KEY',
        'CREDIT_INTERNAL_KEY',
        'POSTGRES_PASSWORD',
        'JWT_PRIVATE_KEY',
      ]) {
        expect(said).toContain(name);
      }
      expect(said).not.toContain('RABBITMQ_PASSWORD');
      expect(said).toContain('docker compose down -v');
      expect(said).not.toContain(shared);
    }
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(old);
  });

  it('says to start the volumes afresh when it adds a database password to an existing .env', () => {
    const { dir, run } = sandbox();
    writeFileSync(join(dir, '.env'), 'MY_OWN_SETTING=1\n');

    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('docker compose down -v');
  });

  it('--check fails and names what is missing, and writes nothing', () => {
    const { dir, run } = sandbox();
    const missing = run('--check');
    expect(missing.status).toBe(1);
    expect(existsSync(join(dir, '.env'))).toBe(false);

    run();
    expect(run('--check').status).toBe(0);

    const stale = readFileSync(join(dir, '.env'), 'utf8').replace(/^METRICS_TOKEN=.*\n/m, '');
    writeFileSync(join(dir, '.env'), stale);
    const check = run('--check');
    expect(check.status).toBe(1);
    expect(check.stdout + check.stderr).toContain('METRICS_TOKEN');
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(stale);
  });
});
