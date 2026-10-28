import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

/**
 * REL-02 (#168), PL-NFR4.1.1 — the requirements traceability matrix. `docs/traceability.yaml` maps
 * each Must requirement of the D1 backlog to the automated tests that prove it; this module checks
 * that every test it names exists, and renders it as `docs/traceability.md`.
 */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const TRACEABILITY_FILE = join(REPO_ROOT, 'docs/traceability.yaml');
export const MATRIX_FILE = join(REPO_ROOT, 'docs/traceability.md');

/** PL-NFR4.1.1's areas. A Must requirement in any of them maps to at least one automated test. */
export const AREAS = [
  'roles',
  'transitions',
  'reservations',
  'returns',
  'transfers',
  'repeats',
] as const;
export type Area = (typeof AREAS)[number];

const AREA_WORDS: Record<Area, string> = {
  roles: 'roles',
  transitions: 'errand transitions',
  reservations: 'reservations',
  returns: 'returns',
  transfers: 'transfers',
  repeats: 'repeated requests',
};

export interface Requirement {
  id: string;
  text: string;
  areas?: Area[];
  /** `path::title`: the exact title of an `it(` or `test(` in that file, or a bash `pass "` check. */
  tests?: string[];
  /** Repository paths of what proves it when no test does, such as a measured report. */
  evidence?: string[];
  /** What is missing, when nothing automated proves it yet. */
  gap?: string;
}

export interface EdgeCase {
  id: string;
  title: string;
  decision: string;
  requirements: string[];
  tests: string[];
}

export interface FeedbackPoint {
  point: string;
  /** Requirement IDs, tickets (`#186`) or repository paths, such as a decision record. */
  answeredBy: string[];
}

export interface Traceability {
  requirements: Requirement[];
  edgeCases: EdgeCase[];
  feedback: FeedbackPoint[];
}

const REQUIREMENT_ID = /^(US|SS|OS|CS|EI|PL|UI)-(FR|NFR)\d+(\.\d+)+$/;
const TICKET = /^#\d+$/;

export function loadTraceability(file = TRACEABILITY_FILE): Traceability {
  return yaml.load(readFileSync(file, 'utf8')) as Traceability;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Why `identifier` names no test in the repository at `root`, or undefined when it does. */
function missingTest(identifier: string, root: string): string | undefined {
  const at = identifier.indexOf('::');
  if (at < 0) return `"${identifier}" is not path::title`;
  const path = identifier.slice(0, at);
  const title = identifier.slice(at + 2);
  if (!existsSync(join(root, path))) return `${path} does not exist`;
  const source = readFileSync(join(root, path), 'utf8');
  if (path.endsWith('.sh')) {
    return source.includes(`pass "${title}`) ? undefined : `no check "${title}" in ${path}`;
  }
  // The title as a string literal, in any quote, as the first argument of it( or test(, or of the
  // function it.each(...) returns. An apostrophe may be escaped in the source.
  const literal = escapeRegExp(title).replace(/'/g, "\\\\?'");
  const call = new RegExp(String.raw`(?:\b(?:it|test)(?:\.\w+)?|\))\(\s*(['"\x60])${literal}\1`);
  return call.test(source) ? undefined : `no test titled "${title}" in ${path}`;
}

/** What is wrong with the matrix, one sentence each; empty when nothing is. */
export function findTraceabilityProblems(t: Traceability, root = REPO_ROOT): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of t.requirements) {
    const say = (problem: string) => problems.push(`${r.id}: ${problem}`);
    if (!REQUIREMENT_ID.test(r.id)) say('not a requirement ID');
    if (seen.has(r.id)) say('listed twice');
    seen.add(r.id);
    for (const area of r.areas ?? []) {
      if (!AREAS.includes(area)) say(`unknown area "${area}"`);
    }
    const tests = r.tests ?? [];
    for (const test of tests) {
      const missing = missingTest(test, root);
      if (missing) say(missing);
    }
    for (const path of r.evidence ?? []) {
      if (!existsSync(join(root, path))) say(`evidence ${path} does not exist`);
    }
    const area = (r.areas ?? []).find((a) => AREAS.includes(a));
    if (area && tests.length === 0) {
      say(`about ${AREA_WORDS[area]}, so it needs an automated test (PL-NFR4.1.1)`);
    } else if (tests.length === 0 && !r.evidence?.length && !r.gap) {
      say('no test, evidence or recorded gap');
    }
  }
  for (const ec of t.edgeCases) {
    for (const id of ec.requirements) {
      if (!REQUIREMENT_ID.test(id)) problems.push(`${ec.id}: "${id}" is not a requirement ID`);
    }
    if (ec.tests.length === 0) problems.push(`${ec.id}: no test proves its decision`);
    for (const test of ec.tests) {
      const missing = missingTest(test, root);
      if (missing) problems.push(`${ec.id}: ${missing}`);
    }
  }
  for (const f of t.feedback) {
    for (const answer of f.answeredBy) {
      if (REQUIREMENT_ID.test(answer) || TICKET.test(answer)) continue;
      if (!existsSync(join(root, answer))) {
        problems.push(`D1 feedback "${f.point}": ${answer} does not exist`);
      }
    }
  }
  return problems;
}

const SERVICES: [prefix: string, name: string][] = [
  ['US', 'User Service'],
  ['SS', 'Supplier Service'],
  ['OS', 'Order Service'],
  ['CS', 'Credit Service'],
  ['EI', 'Event integration'],
  ['PL', 'Platform'],
  ['UI', 'Web app'],
];

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/** `path::title` as `path` — title, linked to the file. */
function testLink(identifier: string): string {
  const at = identifier.indexOf('::');
  const path = identifier.slice(0, at);
  return `[\`${path}\`](../${path}) ${cell(identifier.slice(at + 2).trim())}`;
}

/** A requirement ID links to its row when the matrix has one; a parent requirement has none. */
function answer(item: string, rows: Set<string>): string {
  if (REQUIREMENT_ID.test(item)) {
    return rows.has(item) ? `[${item}](#${item.toLowerCase().replace(/\./g, '')})` : item;
  }
  if (TICKET.test(item)) {
    return `[${item}](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/${item.slice(1)})`;
  }
  return `[\`${item}\`](../${item})`;
}

function provedBy(r: Requirement): string {
  const lines = (r.tests ?? []).map(testLink);
  for (const path of r.evidence ?? []) lines.push(`Evidence: [\`${path}\`](../${path})`);
  if (r.gap) lines.push(`**Gap:** ${cell(r.gap)}`);
  return lines.join('<br>');
}

/** The matrix as markdown, for docs/traceability.md. */
export function renderTraceability(t: Traceability): string {
  const out: string[] = [];
  const count = (rs: Requirement[], which: (r: Requirement) => boolean) => rs.filter(which).length;
  const tested = (r: Requirement) => (r.tests ?? []).length > 0;
  const partly = (r: Requirement) => tested(r) && !!r.gap;
  const evidenced = (r: Requirement) => !tested(r) && (r.evidence ?? []).length > 0;
  const unproved = (r: Requirement) => !tested(r) && !evidenced(r);
  const inArea = (r: Requirement) => (r.areas ?? []).length > 0;
  const rows = new Set(t.requirements.map((r) => r.id));

  out.push(
    '# Requirements traceability',
    '',
    '<!-- Generated from docs/traceability.yaml by `npm run traceability -w test-harness`. Edit the YAML, then run that. -->',
    '',
    'Every **Must** requirement of the D1 backlog (`docs/Project D1 Submission.docx`, as revised in',
    '[#186](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/186)), with the automated tests that prove it',
    '(PL-NFR4.1.1, REL-02 [#168](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/168)). A test is',
    '`file` and its exact title. A requirement no test proves yet shows the evidence that does, such as a',
    'measured report, or names the gap.',
    '',
    'CI checks this matrix (`test-harness/test/traceability.test.ts`): every test it names must exist, and',
    'every requirement about roles, errand transitions, reservations, returns, transfers or repeated',
    'requests must have at least one. Those requirements are marked with their area. Where tests prove',
    'only part of a requirement, the part they leave out is recorded as a gap beside them.',
    '',
    '| | Must requirements | Proved by tests | of which, with a gap recorded | Evidence only | Not yet proved | In a PL-NFR4.1.1 area |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const [prefix, name] of SERVICES) {
    const rs = t.requirements.filter((r) => r.id.startsWith(`${prefix}-`));
    out.push(
      `| [${name}](#${name.toLowerCase().replace(/ /g, '-')}) | ${rs.length} | ${count(rs, tested)} | ${count(rs, partly)} | ${count(rs, evidenced)} | ${count(rs, unproved)} | ${count(rs, inArea)} |`,
    );
  }
  const all = t.requirements;
  out.push(
    `| **All** | **${all.length}** | **${count(all, tested)}** | **${count(all, partly)}** | **${count(all, evidenced)}** | **${count(all, unproved)}** | **${count(all, inArea)}** |`,
  );

  for (const [prefix, name] of SERVICES) {
    out.push('', `## ${name}`, '', '| Requirement | Area | Proved by |', '| --- | --- | --- |');
    for (const r of t.requirements.filter((x) => x.id.startsWith(`${prefix}-`))) {
      const areas = (r.areas ?? []).map((a) => AREA_WORDS[a]).join(', ');
      out.push(
        `| <a id="${r.id.toLowerCase().replace(/\./g, '')}"></a>**${r.id}** ${cell(r.text)} | ${areas} | ${provedBy(r)} |`,
      );
    }
  }

  out.push(
    '',
    '## Edge cases',
    '',
    'Each edge case in the D1 backlog, the requirements its decision settles, and the tests that prove the decision.',
    '',
    '| Edge case | Decision | Requirements | Proved by |',
    '| --- | --- | --- | --- |',
  );
  for (const ec of t.edgeCases) {
    out.push(
      `| **${ec.id}** ${cell(ec.title)} | ${cell(ec.decision)} | ${ec.requirements.map((id) => answer(id, rows)).join(', ')} | ${ec.tests.map(testLink).join('<br>')} |`,
    );
  }

  out.push(
    '',
    '## D1 feedback',
    '',
    "Each point of the teaching team's D1 feedback, and the requirement, ticket or decision record that answers it.",
    '',
    '| Feedback | Answered by |',
    '| --- | --- |',
  );
  for (const f of t.feedback)
    out.push(`| ${cell(f.point)} | ${f.answeredBy.map((a) => answer(a, rows)).join(', ')} |`);
  out.push('');
  return out.join('\n');
}
