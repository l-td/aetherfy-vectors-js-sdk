/**
 * No request the SDK builds carries a member the API refuses.
 *
 * The API checks the top-level members of a request body, the keys of every
 * filter in it and the keys of `params` (a misspelt one is a 400
 * INVALID_REQUEST_FIELD / INVALID_FILTER). Every request shape the client
 * builds is recorded here with its options all set, and each member is held
 * to the members the endpoint takes.
 */
import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { Filter } from '../../src/models';

const BASE = 'https://vectors.aetherfy.com';

/** The members each endpoint takes (path suffix -> members). */
const ALLOWED: Record<string, string[]> = {
  'points/query': [
    'shard_key',
    'prefetch',
    'query',
    'using',
    'filter',
    'params',
    'score_threshold',
    'limit',
    'offset',
    'with_vector',
    'with_payload',
    'lookup_from',
    'with_vectors',
  ],
  'points/scroll': [
    'shard_key',
    'offset',
    'limit',
    'filter',
    'with_payload',
    'with_vector',
    'order_by',
    'with_vectors',
  ],
  'points/count': ['shard_key', 'filter', 'exact'],
  'points/delete': ['points', 'shard_key', 'filter'],
  'points/payload': ['payload', 'points', 'filter', 'shard_key', 'key'],
  'points/payload/delete': ['keys', 'points', 'filter', 'shard_key'],
  'points/retrieve': ['ids', 'with_payload', 'with_vector'],
};
const PARAMS = [
  'hnsw_ef',
  'exact',
  'quantization',
  'indexed_only',
  'acorn',
  'idf',
];
const FILTER_KEYS = ['must', 'must_not', 'should', 'min_should'];

const COND = [{ key: 'a', match: { value: 1 } }];
const FILTER: Filter = {
  must: COND,
  mustNot: COND,
  should: COND,
  minShould: { conditions: COND, min_count: 1 },
};

type Recorded = { path: string; body: Record<string, unknown> };

function suffixOf(path: string): string | undefined {
  return Object.keys(ALLOWED)
    .sort((a, b) => b.length - a.length)
    .find(s => path.endsWith(s));
}

/** The members of `body` the endpoint at `path` does not take. */
function refused(path: string, body: Record<string, unknown>): string[] {
  const suffix = suffixOf(path) as string;
  const out = Object.keys(body).filter(k => !ALLOWED[suffix].includes(k));
  const filter = (body.filter ?? {}) as Record<string, unknown>;
  out.push(
    ...Object.keys(filter)
      .filter(k => !FILTER_KEYS.includes(k))
      .map(k => `filter.${k}`)
  );
  const params = (body.params ?? {}) as Record<string, unknown>;
  out.push(
    ...Object.keys(params)
      .filter(k => !PARAMS.includes(k))
      .map(k => `params.${k}`)
  );
  return out;
}

async function recordEveryRequest(): Promise<Recorded[]> {
  const recorded: Recorded[] = [];
  const answer = function (
    this: { req: { path: string } },
    _uri: string,
    body: unknown
  ) {
    recorded.push({
      path: this.req.path,
      body: (body ?? {}) as Record<string, unknown>,
    });
    return [
      200,
      {
        result: { points: [], count: 0, next_page_offset: null },
        status: 'ok',
      },
    ];
  };
  for (const method of ['post', 'put'] as const) {
    nock(BASE).persist()[method](/.*/).reply(answer);
  }
  nock(BASE)
    .persist()
    .get(/.*/)
    .reply(404, {
      error: { code: 'COLLECTION_NOT_FOUND', message: 'not found' },
    });

  const client = new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    workspace: 'home',
    enableConnectionPooling: false,
  });
  const calls: Array<() => Promise<unknown>> = [
    () =>
      client.search('docs', [0.1, 0.2], {
        limit: 5,
        offset: 1,
        queryFilter: FILTER,
        withPayload: false,
        withVectors: true,
        scoreThreshold: 0.5,
        searchParams: { hnsw_ef: 64, exact: false, indexed_only: true },
      }),
    () =>
      client.scroll('docs', {
        limit: 5,
        scrollFilter: FILTER,
        withPayload: false,
        withVectors: true,
      }),
    () => client.count('docs', { countFilter: FILTER, exact: false }),
    () => client.delete('docs', [1, 2]),
    () => client.delete('docs', FILTER),
    () => client.setPayload('docs', { a: 1 }, [1], { key: 'nested' }),
    () => client.overwritePayload('docs', { a: 1 }, [1]),
    () => client.deletePayload('docs', ['a'], [1]),
    () =>
      client.retrieve('docs', [1], { withPayload: false, withVectors: true }),
  ];
  for (const call of calls) {
    try {
      await call();
    } catch {
      // a method whose reply shape the stub does not satisfy still sent its request
    }
  }
  return recorded;
}

afterEach(() => {
  nock.cleanAll();
});

describe('every member of every request is one the endpoint takes', () => {
  it('holds for every shape the client builds', async () => {
    const recorded = (await recordEveryRequest()).filter(r => suffixOf(r.path));
    const seen = new Set(recorded.map(r => suffixOf(r.path)));
    for (const suffix of Object.keys(ALLOWED)) {
      expect(seen.has(suffix)).toBe(true); // the shape was built
    }
    for (const { path, body } of recorded) {
      expect({ path, refused: refused(path, body) }).toEqual({
        path,
        refused: [],
      });
    }
  });

  it('sends minShould whole, as min_should', async () => {
    const recorded = await recordEveryRequest();
    const count = recorded.find(r => r.path.endsWith('points/count'));
    expect((count?.body.filter as Record<string, unknown>).min_should).toEqual(
      FILTER.minShould
    );
    expect(Object.keys(count?.body.filter as object)).toEqual(FILTER_KEYS);
  });
});

describe('CONTROL: the check names a member the endpoint does not take', () => {
  it.each([
    [{ filter: { must: [] }, with_vectors: true }, ['with_vectors']],
    [{ filter: { mustNot: [] } }, ['filter.mustNot']],
    [
      { exact: true, params: { hnsw_ef: 1, bogus: 2 } },
      ['params', 'params.bogus'],
    ],
  ])('%j', (body, expected) => {
    const out = refused('/collections/docs/points/count', body);
    for (const name of expected) expect(out).toContain(name);
  });
});
