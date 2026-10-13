/* eslint-disable no-console -- command-line output */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { CONTRACTS_DIR, parseOpenApi } from '../contracts.js';
import { findEventBreakingChanges, findOpenApiBreakingChanges } from '../compat.js';

/**
 * Fails when any contract under contracts/ changed incompatibly since a base commit.
 *
 *   npm run contracts:compat -w @foc/test-harness -- --base origin/main
 *
 * CI passes the merge base of the pull request, so contract changes that landed on main after the
 * branch was cut are not mistaken for removals.
 */
const args = process.argv.slice(2);
const flag = args.indexOf('--base');
const base = flag >= 0 ? args[flag + 1] : (process.env.CONTRACT_BASE_REF ?? 'origin/main');
if (!base) throw new Error('--base needs a git ref');

const git = (...argv: string[]) =>
  execFileSync('git', argv, {
    cwd: CONTRACTS_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const root = git('rev-parse', '--show-toplevel').trim();
const relative = (file: string) => `contracts/${file}`;
const atBase = (file: string): string | undefined => {
  try {
    return git('-C', root, 'show', `${base}:${relative(file)}`);
  } catch {
    return undefined;
  }
};

const baseFiles = git('-C', root, 'ls-tree', '--name-only', `${base}`, 'contracts/')
  .split('\n')
  .filter(Boolean)
  .map((path) => path.replace(/^contracts\//, ''));
const currentFiles = new Set(readdirSync(CONTRACTS_DIR));

const breaking: string[] = [];
let compared = 0;
for (const file of baseFiles) {
  const isOpenApi = file.endsWith('.openapi.yaml');
  const isEvents = file === 'events.schema.json';
  if (!isOpenApi && !isEvents) continue;
  if (!currentFiles.has(file)) {
    breaking.push(`${file}: contract removed`);
    continue;
  }
  const before = atBase(file);
  if (before === undefined) continue;
  const now = readFileSync(`${CONTRACTS_DIR}${file}`, 'utf8');
  compared += 1;
  if (isOpenApi) {
    breaking.push(
      ...findOpenApiBreakingChanges(
        parseOpenApi(before),
        parseOpenApi(now),
        file.replace('.openapi.yaml', ''),
      ),
    );
  } else {
    breaking.push(...findEventBreakingChanges(JSON.parse(before).events, JSON.parse(now).events));
  }
}

if (breaking.length > 0) {
  console.error(`Breaking contract changes against ${base}:\n  - ${breaking.join('\n  - ')}`);
  console.error(
    '\nv1 contracts are additive only (contracts/README.md). Add a new field or operation instead of changing one.',
  );
  process.exit(1);
}
console.log(`No breaking contract changes against ${base} (${compared} contracts compared).`);
