// Mounted only by compose.e2e.yaml into the disposable release backend containers. Never baked into an image.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import process from 'node:process';
import pg from 'pg';

if (
  process.env.NODE_ENV !== 'development' ||
  process.env.E2E_CLOCK_PROJECT !== 'foc-e2e-release' ||
  !process.env.E2E_CLOCK_FILE ||
  !isAbsolute(process.env.E2E_CLOCK_FILE)
) {
  throw new Error(
    'The E2E clock requires the explicit disposable development release configuration.',
  );
}
const file = process.env.E2E_CLOCK_FILE;
const RealDate = globalThis.Date;
function offset() {
  const text = readFileSync(file, 'utf8').trim();
  if (!/^\d+$/.test(text)) throw new Error('Invalid E2E clock offset.');
  const ms = Number(text);
  if (!Number.isSafeInteger(ms) || ms > 14 * 24 * 60 * 60_000)
    throw new Error('E2E clock offset must be 0..14 days.');
  return ms;
}
offset(); // Fail before the application starts if the clock fixture is absent or corrupt.
const now = () => RealDate.now() + offset();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [now()], newTarget);
  },
  apply() {
    return new RealDate(now()).toString();
  },
  get(target, key, receiver) {
    return key === 'now' ? now : Reflect.get(target, key, receiver);
  },
});

// Order deliberately uses PostgreSQL time for locked transitions. Offset explicit clock reads
// as well as Node's clock; faking only the browser/Node clock would not exercise those timers.
// Every statement still executes against real PostgreSQL. No order, wallet, ledger or history row
// is edited by this fixture, and no HTTP clock-control route exists.
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (config, ...args) {
  const ms = offset();
  const shift = (sql) =>
    sql.replace(
      /\b(now|clock_timestamp)\s*\(\s*\)/gi,
      (_match, name) => `(${name.toLowerCase()}() + interval '${ms} milliseconds')`,
    );
  if (ms && typeof config === 'string') config = shift(config);
  else if (ms && typeof config?.text === 'string' && typeof config.submit !== 'function')
    config = { ...config, text: shift(config.text) };
  return Reflect.apply(query, this, [config, ...args]);
};
