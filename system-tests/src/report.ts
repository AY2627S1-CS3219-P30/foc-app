import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RABBITMQ_URL, TEST_POSTGRES_URL } from '@foc/test-harness';
import { agreementViolations, economyViolations } from './invariants.js';
import { RabbitWiring } from './rabbit.js';
import { accept, command, createOrder } from './scenario.js';
import { simulate, type SimulationResult } from './simulation.js';
import { Stack } from './stack.js';

const REPORTS = fileURLToPath(new URL('../../docs/reports/', import.meta.url));
const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

async function contention(adminUrl: string): Promise<Check> {
  const stack = await Stack.start(adminUrl, 'report_contention');
  try {
    await stack.issueWallet('requester');
    const couriers = Array.from({ length: 100 }, (_, i) => `courier-${i}`);
    for (const courier of couriers) await stack.issueWallet(courier);
    const orderId = await createOrder(stack, 'requester', 5);
    await stack.settle();
    const started = performance.now();
    const attempts = await Promise.all(couriers.map((c) => stack.orders.accept(orderId, c, 2, c)));
    const elapsed = performance.now() - started;
    const winners = attempts.filter((a) => a.accepted);
    const winner = winners[0]?.order?.courierId;
    if (winner) {
      await command(stack, orderId, 'RECORD_PICKUP', winner);
      await command(stack, orderId, 'RECORD_DELIVERY', winner);
      await command(stack, orderId, 'CONFIRM_RECEIPT', 'requester');
      await stack.settle();
    }
    const violations = [
      ...(await economyViolations(stack)),
      ...(await agreementViolations(stack, true)),
    ];
    const passed = winners.length === 1 && violations.length === 0;
    return {
      name: 'OS-FR3.1.2 contention (100 simultaneous acceptances, then completion)',
      passed,
      detail: `${winners.length} winner, ${attempts.length - winners.length} conflicts, ${elapsed.toFixed(0)} ms for all attempts${violations.length ? `; ${violations.join('; ')}` : ''}`,
    };
  } finally {
    await stack.stop();
  }
}

async function brokerReplay(adminUrl: string, rabbitUrl: string): Promise<Check> {
  const stack = await Stack.start(adminUrl, 'report_broker');
  const wiring = await RabbitWiring.start(stack, rabbitUrl, { replay: true });
  try {
    await stack.issueWallet('requester');
    await stack.issueWallet('courier');
    const done = await createOrder(stack, 'requester', 4);
    const dropped = await createOrder(stack, 'requester', 2);
    await wiring.settle();
    await accept(stack, done, 'courier');
    await command(stack, done, 'RECORD_PICKUP', 'courier');
    await command(stack, done, 'RECORD_DELIVERY', 'courier');
    await command(stack, done, 'CONFIRM_RECEIPT', 'requester');
    await command(stack, dropped, 'CANCEL', 'requester');
    await wiring.settle();
    await wiring.republish([...wiring.published]);
    await wiring.settle();
    const violations = [
      ...(await economyViolations(stack)),
      ...(await agreementViolations(stack, true)),
    ];
    const effects = [
      ...(await stack.transactionsFor(done)),
      ...(await stack.transactionsFor(dropped)),
    ];
    const passed = violations.length === 0 && effects.join() === 'RESERVE,TRANSFER,RESERVE,RELEASE';
    return {
      name: 'RabbitMQ replay (every event published twice, then the whole run replayed)',
      passed,
      detail: `${wiring.published.length} events, ${wiring.published.length * 3} publications; effects [${effects.join(', ')}]${violations.length ? `; ${violations.join('; ')}` : ''}`,
    };
  } finally {
    await wiring.stop();
    await stack.stop();
  }
}

const sha = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

export async function runReport(): Promise<number> {
  if (!TEST_POSTGRES_URL) {
    console.error(
      'TEST_POSTGRES_URL is required (npm run report:conservation sets it from Compose).',
    );
    return 2;
  }
  const options = {
    seeds: num('LOAD_SEEDS', 20),
    firstSeed: num('LOAD_FIRST_SEED', 1001),
    steps: num('LOAD_STEPS', 150),
    users: num('LOAD_USERS', 10),
  };
  const started = new Date();
  const runs: SimulationResult[] = [];
  for (let i = 0; i < options.seeds; i++) {
    const seed = options.firstSeed + i;
    const stack = await Stack.start(TEST_POSTGRES_URL, `load_${seed}`);
    try {
      runs.push(
        await simulate(stack, {
          seed,
          users: options.users,
          steps: options.steps,
          dropRate: 0.1,
          duplicateRate: 0.15,
        }),
      );
    } finally {
      await stack.stop();
    }
    process.stdout.write(
      `seed ${seed}: ${runs.at(-1)!.violations.length === 0 ? 'ok' : 'VIOLATED'}\n`,
    );
  }
  const checks: Check[] = [await contention(TEST_POSTGRES_URL)];
  if (RABBITMQ_URL) checks.push(await brokerReplay(TEST_POSTGRES_URL, RABBITMQ_URL));

  const finished = new Date();
  const sum = (pick: (r: SimulationResult) => number) =>
    runs.reduce((total, r) => total + pick(r), 0);
  const statuses: Record<string, number> = {};
  for (const run of runs) {
    for (const [status, n] of Object.entries(run.finalStatuses))
      statuses[status] = (statuses[status] ?? 0) + n;
  }
  const violated = runs.filter((r) => r.violations.length > 0);
  const passed = violated.length === 0 && checks.every((c) => c.passed);
  const pgVersion = await (async () => {
    const stack = await Stack.start(TEST_POSTGRES_URL!, 'report_version');
    try {
      const result = await stack.orderDb.db.query<{ version: string }>(`SELECT version()`);
      return result.rows[0]!.version.split(' on ')[0]!;
    } finally {
      await stack.stop();
    }
  })();

  const date = started.toISOString().slice(0, 10);
  const summary = {
    date,
    passed,
    commit: sha(),
    startedAt: started.toISOString(),
    durationSeconds: Math.round((finished.getTime() - started.getTime()) / 1000),
    environment: { node: process.version, postgres: pgVersion, rabbitmq: Boolean(RABBITMQ_URL) },
    options,
    totals: {
      orders: sum((r) => r.orders),
      operations: sum((r) => Object.values(r.operations).reduce((a, b) => a + b, 0)),
      refused: sum((r) => r.refused),
      deliveriesHandled: sum((r) => r.deliveries.handled),
      deliveriesDropped: sum((r) => r.deliveries.dropped),
      deliveriesDuplicated: sum((r) => r.deliveries.duplicated),
      repairs: sum((r) => r.repairs),
      finalStatuses: statuses,
    },
    checks,
    runs,
  };

  const lines = [
    `# Credit conservation report — ${date}`,
    '',
    `**Result: ${passed ? 'PASS' : 'FAIL'}** · commit \`${summary.commit.slice(0, 12)}\` · ${summary.durationSeconds} s · Node ${process.version} · ${pgVersion}${RABBITMQ_URL ? ' · RabbitMQ' : ''}`,
    '',
    'Generated by `npm run report:conservation` (NTH-05, #165). Rerunning it with the same options',
    'replays the same seeded sequences. Order and Credit run their real code on their own',
    'PostgreSQL databases from the Compose stack; see `system-tests/README.md`.',
    '',
    '## Invariants',
    '',
    'Checked after every step of every run, and again after settling:',
    '',
    '- no wallet balance is negative or fractional;',
    '- every ledger transaction balances (debits = credits);',
    '- total credits held equal total credits issued (conservation except issuance);',
    '- each order is reserved at most once and has at most one terminal outcome (transfer or release);',
    '- once settled, Order and Credit agree on every order and none is left waiting on Credit.',
    '',
    '## Seeded load',
    '',
    `${options.seeds} seeds (${options.firstSeed}–${options.firstSeed + options.seeds - 1}) × ${options.steps} steps × ${options.users} users; 10 % of deliveries dropped, 15 % duplicated.`,
    '',
    '| Measure | Total |',
    '| --- | --- |',
    `| Orders created | ${summary.totals.orders} |`,
    `| Operations attempted | ${summary.totals.operations} |`,
    `| Refused (invalid actor or state) | ${summary.totals.refused} |`,
    `| Deliveries handled | ${summary.totals.deliveriesHandled} |`,
    `| Deliveries dropped | ${summary.totals.deliveriesDropped} |`,
    `| Deliveries duplicated | ${summary.totals.deliveriesDuplicated} |`,
    `| Reconciliation re-issues | ${summary.totals.repairs} |`,
    `| Final statuses | ${Object.entries(statuses)
      .sort()
      .map(([s, n]) => `${s} ${n}`)
      .join(', ')} |`,
    `| Runs with a violated invariant | ${violated.length} |`,
    '',
    ...(violated.length
      ? [
          '### Violations',
          '',
          ...violated.flatMap((r) => [`Seed ${r.seed}:`, ...r.violations.map((v) => `- ${v}`)]),
          '',
        ]
      : []),
    '## Targeted checks',
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    ...checks.map((c) => `| ${c.name} | ${c.passed ? 'PASS' : 'FAIL'} | ${c.detail} |`),
    '',
    'Per-run detail is in the JSON file beside this report.',
    '',
  ];
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(`${REPORTS}credit-conservation-${date}.md`, lines.join('\n'));
  writeFileSync(
    `${REPORTS}credit-conservation-${date}.json`,
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  process.stdout.write(
    `wrote docs/reports/credit-conservation-${date}.{md,json}: ${passed ? 'PASS' : 'FAIL'}\n`,
  );
  return passed ? 0 : 1;
}
