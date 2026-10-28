import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const moduleUrl = pathToFileURL(resolve(root, 'test-harness/e2e-clock.mjs')).href;
function child(script: string, offset: string, environment: Record<string, string> = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'foc-e2e-clock-'));
  const file = resolve(directory, 'offset-ms');
  writeFileSync(file, offset);
  try {
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      env: {
        NODE_ENV: 'development',
        E2E_CLOCK_PROJECT: 'foc-e2e-release',
        E2E_CLOCK_FILE: file,
        ...environment,
      },
      encoding: 'utf8',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const load = `await import(${JSON.stringify(moduleUrl)});`;

describe('isolated release clock', () => {
  it('refuses production, an ordinary project, and an absent/corrupt clock before application startup', () => {
    const invalidEnvironments: Record<string, string>[] = [
      { NODE_ENV: 'production' },
      { E2E_CLOCK_PROJECT: 'foc' },
      { E2E_CLOCK_FILE: '' },
    ];
    for (const environment of invalidEnvironments) {
      const result = child(load, '0', environment);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('explicit disposable development release configuration');
    }
    for (const value of ['not a number', '-1', '1209600001']) {
      const result = child(load, value);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Invalid E2E clock offset|0\.\.14 days/);
    }
  });

  it('moves implicit Node time and SQL clock reads together, preserving dates, query values and callbacks', () => {
    const result = child(
      `
      import pg from 'pg';
      const realNow = Date.now();
      const calls = [];
      pg.Client.prototype.query = function(config, ...args) { calls.push([config, ...args]); return 'result'; };
      ${load}
      const client = new pg.Client();
      const callback = () => {};
      const returned = client.query('SELECT now() AS now, $1', ['unchanged'], callback);
      client.query({text: 'SELECT NOW() AS now, clock_timestamp() AS finished', rowMode: 'array'}, [42]);
      console.log(JSON.stringify({
        delta: Date.now() - realNow, constructed: new Date().getTime() - realNow,
        explicit: new Date('2000-01-01T00:00:00Z').toISOString(),
        parsed: Date.parse('2000-01-01T00:00:00Z'),
        sql: calls[0][0], values: calls[0][1], callback: calls[0][2] === callback, returned,
        config: calls[1][0], configValues: calls[1][1]
      }));
    `,
      '3600000',
    );
    expect(result.status, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.delta).toBeGreaterThanOrEqual(3_600_000);
    expect(data.delta).toBeLessThan(3_605_000);
    expect(data.constructed).toBeGreaterThanOrEqual(3_600_000);
    expect(data.explicit).toBe('2000-01-01T00:00:00.000Z');
    expect(data.parsed).toBe(946684800000);
    expect(data.sql).toBe("SELECT (now() + interval '3600000 milliseconds') AS now, $1");
    expect(data.values).toEqual(['unchanged']);
    expect(data.callback).toBe(true);
    expect(data.returned).toBe('result');
    expect(data.config).toEqual({
      text: "SELECT (now() + interval '3600000 milliseconds') AS now, (clock_timestamp() + interval '3600000 milliseconds') AS finished",
      rowMode: 'array',
    });
    expect(data.configValues).toEqual([42]);
  });

  it('keeps the zero-offset database statements unchanged', () => {
    const result = child(
      `
      import pg from 'pg';
      pg.Client.prototype.query = (sql) => sql;
      ${load}
      console.log(new pg.Client().query('SELECT now() AS now'));
    `,
      '0',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('SELECT now() AS now');
  });
});
