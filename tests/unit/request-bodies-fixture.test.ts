/**
 * tests/fixtures/request-bodies.json is what the client sends, today.
 *
 * The API's own tests read that file and send every body through its request
 * validation, so the file is only worth anything while it is true. This test
 * regenerates it from the client's mocked HTTP layer and fails when it differs: a
 * request the client builds differently needs the file regenerated and committed
 * (`npm run record:request-bodies`), and that is the moment the API's validation
 * sees the new body.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  DELIBERATELY_INVALID,
  RequestBodyRow,
  dumpRequestBodies,
  recordRequestBodies,
  sortKeys,
} from './record-request-bodies';

const FIXTURE = path.resolve(__dirname, '../fixtures/request-bodies.json');

/** What differs, by row name, in words; empty when they match. */
export function describeDifference(
  recorded: RequestBodyRow[],
  committed: RequestBodyRow[]
): string[] {
  const key = (r: RequestBodyRow) => `${r.name} (${r.method} ${r.route})`;
  // Key order is not compared: the file is written with its keys sorted.
  const canonical = (r: RequestBodyRow) => JSON.stringify(sortKeys(r.body));
  const now = new Map(recorded.map(r => [key(r), canonical(r)]));
  const then = new Map(committed.map(r => [key(r), canonical(r)]));
  const lines: string[] = [];
  for (const k of [...now.keys()].sort()) {
    if (!then.has(k)) lines.push(`new request not in the file: ${k}`);
  }
  for (const k of [...then.keys()].sort()) {
    if (!now.has(k)) {
      lines.push(`the file has a request the client no longer sends: ${k}`);
    }
  }
  for (const k of [...now.keys()].sort()) {
    if (then.has(k) && then.get(k) !== now.get(k)) {
      lines.push(`the body of ${k} changed: ${then.get(k)} -> ${now.get(k)}`);
    }
  }
  return lines;
}

const read = (): RequestBodyRow[] =>
  JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as RequestBodyRow[];

describe('tests/fixtures/request-bodies.json', () => {
  it('is what the client sends', async () => {
    const recorded = await recordRequestBodies();
    if (process.env.RECORD_REQUEST_BODIES === '1') {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, dumpRequestBodies(recorded));
    }
    const difference = describeDifference(recorded, read());
    expect({
      stale: difference.length > 0,
      regenerateWith: 'npm run record:request-bodies',
      difference,
    }).toEqual({
      stale: false,
      regenerateWith: 'npm run record:request-bodies',
      difference: [],
    });
    expect(dumpRequestBodies(recorded)).toBe(fs.readFileSync(FIXTURE, 'utf8'));
  }, 60_000);

  it('covers every endpoint the client writes', () => {
    const seen = new Set(
      read().map(r => `${r.method} ${r.route.replace('/collections/docs', '')}`)
    );
    for (const want of [
      'POST /points/query',
      'POST /points/scroll',
      'POST /points/count',
      'POST /points/delete',
      'POST /points/payload',
      'POST /points/payload/delete',
      'POST /points/retrieve',
      'PUT /points',
      'PUT /points/payload',
      'POST /collections',
      'PUT /index',
      'PUT /schema',
      'POST /schema/analyze',
    ]) {
      expect(seen).toContain(want);
    }
    expect(
      read().some(r => (r.body.filter as { min_should?: unknown })?.min_should)
    ).toBe(true);
  });

  it('holds every deliberately invalid row', () => {
    const names = new Set(read().map(r => r.name));
    for (const name of Object.keys(DELIBERATELY_INVALID)) {
      expect(names).toContain(name);
    }
  });
});

describe('CONTROLS: the comparison is not vacuous', () => {
  it('reports a changed body', () => {
    const committed = read();
    const mutated = JSON.parse(JSON.stringify(committed)) as RequestBodyRow[];
    mutated[0].body.added_member = 1;
    const difference = describeDifference(committed, mutated);
    expect(difference).toHaveLength(1);
    expect(difference[0]).toContain('changed');
  });

  it('reports a new request', () => {
    const committed = read();
    expect(describeDifference(committed, committed.slice(1))[0]).toMatch(
      /^new request/
    );
  });

  it('reports a vanished request', () => {
    const committed = read();
    expect(describeDifference(committed.slice(1), committed)[0]).toContain(
      'no longer sends'
    );
  });
});
