import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MATRIX_FILE,
  findTraceabilityProblems,
  loadTraceability,
  renderTraceability,
  type Requirement,
  type Traceability,
} from '../src/traceability.js';

/**
 * REL-02 (#168), PL-NFR4.1.1 — every Must requirement maps to the automated tests that prove it.
 * The checker is tested on small fixtures first; then the real matrix must have no problems, and
 * the rendered docs/traceability.md must be current with it.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository root holding the given files. */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'foc-trace-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const SUITE = `describe('orders', () => {
  it('refuses a second acceptance', () => {});
  it(
    'returns the credits when the errand expires',
    () => {},
  );
  test('keeps the requester\\'s errand', () => {});
  it.each(['role', 'status'])('rejects %s as not editable', () => {});
});
`;
const SCRIPT = `pass "the edge refuses a 2 MB request (413)" || fail "a 2 MB request answered $code"
pass "stack healthy in \${ELAPSED}s"
`;

const matrix = (requirements: Requirement[], extra: Partial<Traceability> = {}): Traceability => ({
  requirements,
  edgeCases: [],
  feedback: [],
  ...extra,
});

describe('the traceability checker', () => {
  const root = () => repo({ 'svc/test/orders.test.ts': SUITE, 'scripts-smoke.sh': SCRIPT });

  it('accepts a requirement proved by tests that exist', () => {
    const problems = findTraceabilityProblems(
      matrix([
        {
          id: 'OS-FR3.1.1',
          text: 'One courier.',
          areas: ['transitions'],
          tests: [
            'svc/test/orders.test.ts::refuses a second acceptance',
            'svc/test/orders.test.ts::returns the credits when the errand expires',
          ],
        },
      ]),
      root(),
    );
    expect(problems).toEqual([]);
  });

  it('finds an escaped apostrophe, an it.each title and a bash check by its pass message', () => {
    const problems = findTraceabilityProblems(
      matrix([
        {
          id: 'OS-FR3.1.2',
          text: 'Kept.',
          tests: [
            "svc/test/orders.test.ts::keeps the requester's errand",
            'svc/test/orders.test.ts::rejects %s as not editable',
            'scripts-smoke.sh::the edge refuses a 2 MB request (413)',
            'scripts-smoke.sh::stack healthy in ',
          ],
        },
      ]),
      root(),
    );
    expect(problems).toEqual([]);
  });

  it('names a test whose file or title does not exist', () => {
    const problems = findTraceabilityProblems(
      matrix([
        {
          id: 'OS-FR3.1.1',
          text: 'One courier.',
          tests: [
            'svc/test/orders.test.ts::refuses a third acceptance',
            'svc/test/gone.test.ts::anything',
            'no separator here',
          ],
        },
      ]),
      root(),
    );
    expect(problems).toEqual([
      'OS-FR3.1.1: no test titled "refuses a third acceptance" in svc/test/orders.test.ts',
      'OS-FR3.1.1: svc/test/gone.test.ts does not exist',
      'OS-FR3.1.1: "no separator here" is not path::title',
    ]);
  });

  it('requires a test for a requirement in a PL-NFR4.1.1 area: evidence alone is not enough', () => {
    const problems = findTraceabilityProblems(
      matrix([
        { id: 'CS-FR3.1.1', text: 'Reserve.', areas: ['reservations'], evidence: ['README.md'] },
      ]),
      repo({ 'README.md': '#' }),
    );
    expect(problems).toEqual([
      'CS-FR3.1.1: about reservations, so it needs an automated test (PL-NFR4.1.1)',
    ]);
  });

  it('requires every requirement to have a test, evidence or a recorded gap', () => {
    const problems = findTraceabilityProblems(
      matrix([
        { id: 'UI-NFR3.1.1', text: 'Fast.' },
        { id: 'UI-NFR3.1.2', text: 'Faster.', gap: 'No Lighthouse run yet (#166).' },
        { id: 'UI-NFR3.1.3', text: 'Fastest.', evidence: ['docs/gone.md'] },
      ]),
      repo({}),
    );
    expect(problems).toEqual([
      'UI-NFR3.1.1: no test, evidence or recorded gap',
      'UI-NFR3.1.3: evidence docs/gone.md does not exist',
    ]);
  });

  it('refuses an unknown area, a malformed or repeated ID, and an edge case with no test', () => {
    const problems = findTraceabilityProblems(
      matrix(
        [
          { id: 'OS-FR3.1.1', text: 'A.', areas: ['payments' as never], gap: 'x' },
          { id: 'OS-FR3.1.1', text: 'B.', gap: 'x' },
          { id: 'ORD-03', text: 'C.', gap: 'x' },
        ],
        {
          edgeCases: [
            {
              id: 'EC3',
              title: 'T',
              decision: 'D',
              requirements: ['OS-FR6.1.1', 'nope'],
              tests: [],
            },
          ],
          feedback: [{ point: 'P', answeredBy: ['#186', 'OS-FR6.1.1', 'docs/adr/none.md'] }],
        },
      ),
      repo({}),
    );
    expect(problems).toEqual([
      'OS-FR3.1.1: unknown area "payments"',
      'OS-FR3.1.1: listed twice',
      'ORD-03: not a requirement ID',
      'EC3: "nope" is not a requirement ID',
      'EC3: no test proves its decision',
      'D1 feedback "P": docs/adr/none.md does not exist',
    ]);
  });
});

describe('the rendered matrix', () => {
  it('links a requirement ID only when the matrix has a row for it', () => {
    const page = renderTraceability(
      matrix([{ id: 'OS-FR3.1.1', text: 'One courier.', gap: 'x' }], {
        edgeCases: [
          {
            id: 'EC3',
            title: 'T',
            decision: 'D',
            requirements: ['OS-FR3.1.1', 'OS-FR3.1'],
            tests: [],
          },
        ],
      }),
    );
    expect(page).toContain('[OS-FR3.1.1](#os-fr311), OS-FR3.1 |');
  });
});

describe('docs/traceability.yaml', () => {
  it('lists the D1 backlog’s 131 Must requirements, each once', () => {
    // The leaf requirements marked Must in docs/Project D1 Submission.docx, as revised by DOC-02 (#186).
    const ids = loadTraceability().requirements.map((r) => r.id);
    expect(ids).toHaveLength(131);
    expect(new Set(ids).size).toBe(131);
  });

  it('has no problems: every test it names exists, and every PL-NFR4.1.1 requirement has one', () => {
    expect(findTraceabilityProblems(loadTraceability())).toEqual([]);
  });

  it('is what docs/traceability.md shows (npm run traceability -w test-harness)', () => {
    expect(readFileSync(MATRIX_FILE, 'utf8')).toBe(renderTraceability(loadTraceability()));
  });
});
