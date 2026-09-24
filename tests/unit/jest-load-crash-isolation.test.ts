/**
 * The Jest behaviour tests/node-environment.ts relies on, held by a test.
 *
 * Why this exists: a test file that failed to LOAD used to leave nock switched
 * on for the rest of its worker (its afterAll never ran), and every later file
 * on that worker was refused requests it had mocked — "Nock: Disallowed net
 * connect", which looked like a load-dependent flake. The fix (17c9ee0) moved
 * the switch-off into the test environment's teardown(), which Jest runs for
 * every file, including one that crashed while loading.
 *
 * That "including one that crashed" is a property of Jest, not of this repo,
 * and it was proved by running it once. A Jest major (dependabot bumps it) can
 * change it silently. So this runs a REAL Jest — a child process, on the
 * fixture project in tests/fixtures/load-crash-isolation, with this repo's own
 * node-environment.ts and node-setup.ts — where file A throws while loading and
 * file B mocks a request, in one process, A first (--runInBand plus a path-order
 * sequencer). It asserts A failed, B passed, and B's mocked request was served.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'load-crash-isolation');

interface SuiteResult {
  name: string;
  status: string;
  message: string;
  assertionResults: { title: string; status: string }[];
}

it('a file that crashes while loading does not break the next file', () => {
  const out = mkdtempSync(join(tmpdir(), 'afy-jest-isolation-'));
  const results = join(out, 'results.json');
  // Each fixture file appends its letter here as it runs. Jest's own timing
  // fields cannot prove the order: a file that fails to load is stamped when
  // its failure is recorded, which can be after the next file has finished.
  const orderFile = join(out, 'order.log');
  const config = {
    rootDir: FIXTURE,
    testMatch: ['<rootDir>/*.test.ts'],
    testEnvironment: join(REPO_ROOT, 'tests', 'node-environment.ts'),
    setupFilesAfterEnv: [join(REPO_ROOT, 'tests', 'node-setup.ts')],
    transform: {
      '^.+\\.ts$': [
        'ts-jest',
        { tsconfig: join(REPO_ROOT, 'tests', 'tsconfig.json') },
      ],
    },
    testSequencer: join(FIXTURE, 'sequencer.js'),
  };

  // A fresh environment for the child: without this, the parent's
  // JEST_WORKER_ID would tell the child Jest it is itself a worker.
  const env: Record<string, string | undefined> = {
    ...process.env,
    AFY_FIXTURE_ORDER_FILE: orderFile,
  };
  delete env.JEST_WORKER_ID;

  try {
    const run = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'jest', 'bin', 'jest.js'),
        '--config',
        JSON.stringify(config),
        '--runInBand',
        '--ci',
        '--json',
        '--outputFile',
        results,
      ],
      { cwd: REPO_ROOT, env, encoding: 'utf8' }
    );
    let report: { testResults: SuiteResult[] };
    try {
      report = JSON.parse(readFileSync(results, 'utf8'));
    } catch {
      throw new Error(
        `The fixture Jest run wrote no results (exit ${run.status}):\n` +
          `${run.stdout}\n${run.stderr}`
      );
    }

    const suites = new Map(
      report.testResults.map(r => [basename(r.name), r] as const)
    );
    const a = suites.get('a-crashes-on-load.test.ts');
    const b = suites.get('b-mocks-a-request.test.ts');

    // Anti-no-op: both files ran, A first. If B ran first it would pass
    // whatever the teardown did, and this test would prove nothing.
    expect([...suites.keys()].sort()).toEqual([
      'a-crashes-on-load.test.ts',
      'b-mocks-a-request.test.ts',
    ]);
    expect(readFileSync(orderFile, 'utf8')).toBe('a\nb\n');

    // A failed, and for the reason it was written to fail.
    expect(a?.status).toBe('failed');
    expect(a?.message).toContain('crash during load (fixture)');

    // B passed: its one test ran and its mocked request was served (the test
    // asserts the mocked body came back and the nock scope was consumed).
    expect({
      status: b?.status,
      tests: b?.assertionResults.map(t => `${t.title}: ${t.status}`),
      message: b?.message,
    }).toEqual({
      status: 'passed',
      tests: ['is served the reply it mocked: passed'],
      message: '',
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 120_000);
