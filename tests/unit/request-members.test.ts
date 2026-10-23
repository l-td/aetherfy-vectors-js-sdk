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
import { DistanceMetric, Filter } from '../../src/models';

const BASE = 'https://vectors.aetherfy.com';

/** The members each endpoint takes ("METHOD path-suffix" -> members). */
const ALLOWED: Record<string, string[]> = {
  'POST points/query': [
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
  'POST points/scroll': [
    'shard_key',
    'offset',
    'limit',
    'filter',
    'with_payload',
    'with_vector',
    'order_by',
    'with_vectors',
  ],
  'POST points/count': ['shard_key', 'filter', 'exact'],
  'POST points/delete': ['points', 'shard_key', 'filter'],
  'PUT points': ['points'],
  'PUT points/payload': ['payload', 'points', 'filter', 'shard_key', 'key'],
  'POST collections': ['name', 'vectors', 'description', 'regions'],
  'PUT index': ['field_name', 'field_schema'],
  'PUT schema': ['schema', 'enforcement_mode', 'description'],
  'POST schema/analyze': ['sample_size'],
  'POST points/payload': ['payload', 'points', 'filter', 'shard_key', 'key'],
  'POST points/payload/delete': ['keys', 'points', 'filter', 'shard_key'],
  'POST points/retrieve': ['ids', 'with_payload', 'with_vector'],
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

type Recorded = {
  method: string;
  path: string;
  body: Record<string, unknown>;
};

function endpointOf(method: string, path: string): string | undefined {
  return Object.keys(ALLOWED)
    .sort((a, b) => b.length - a.length)
    .find(key => {
      const [verb, suffix] = key.split(' ');
      return verb === method && path.endsWith(suffix);
    });
}

/** The members of `body` the endpoint at `path` does not take. */
function refused(
  method: string,
  path: string,
  body: Record<string, unknown>
): string[] {
  const endpoint = endpointOf(method, path) as string;
  const out = Object.keys(body).filter(k => !ALLOWED[endpoint].includes(k));
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
    this: { req: { path: string; method: string } },
    _uri: string,
    body: unknown
  ) {
    recorded.push({
      method: this.req.method,
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
  // An upsert reads the collection's vector config and its schema first.
  nock(BASE)
    .persist()
    .get(/\/collections\/docs$/)
    .reply(200, {
      result: {
        config: { params: { vectors: { size: 2, distance: 'Cosine' } } },
      },
      schema_version: 'v1',
    });
  nock(BASE)
    .persist()
    .get(/\/collections\/docs\/schema$/)
    .reply(404, { error: { code: 'SCHEMA_NOT_DEFINED', message: 'x' } });
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
    () => client.upsert('docs', [{ id: 1, vector: [0.1, 0.2] }]),
    () =>
      client.createCollection(
        'fresh',
        { size: 2, distance: DistanceMetric.COSINE },
        'd',
        ['us-east-1']
      ),
    () => client.createFieldIndex('docs', 'tag', 'keyword'),
    () =>
      client.setSchema(
        'docs',
        { fields: { name: { type: 'string', required: false } } },
        'strict',
        'd'
      ),
    () => client.analyzeSchema('docs', 500),
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
    const recorded = (await recordEveryRequest()).filter(r =>
      endpointOf(r.method, r.path)
    );
    const seen = new Set(recorded.map(r => endpointOf(r.method, r.path)));
    for (const endpoint of Object.keys(ALLOWED)) {
      expect({ endpoint, built: seen.has(endpoint) }).toEqual({
        endpoint,
        built: true, // the shape was built
      });
    }
    for (const { method, path, body } of recorded) {
      expect({ method, path, refused: refused(method, path, body) }).toEqual({
        method,
        path,
        refused: [],
      });
    }
  }, 30_000);

  it('sends minShould whole, as min_should', async () => {
    const recorded = await recordEveryRequest();
    const count = recorded.find(r => r.path.endsWith('points/count'));
    expect((count?.body.filter as Record<string, unknown>).min_should).toEqual(
      FILTER.minShould
    );
    expect(Object.keys(count?.body.filter as object)).toEqual(FILTER_KEYS);
  }, 30_000);
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
    const out = refused('POST', '/collections/docs/points/count', body);
    for (const name of expected) expect(out).toContain(name);
  });

  it.each([
    [
      'PUT',
      '/collections/docs/points',
      { points: [], update_filter: {} },
      ['update_filter'],
    ],
    [
      'PUT',
      '/collections/docs/points/payload',
      { payload: {}, points: [], bogus: 1 },
      ['bogus'],
    ],
    ['POST', '/collections', { name: 'x', vectors: {}, bogus: 1 }, ['bogus']],
    [
      'PUT',
      '/collections/docs/index',
      { field_name: 'a', field_type: 'keyword' },
      ['field_type'],
    ],
    [
      'PUT',
      '/collections/docs/schema',
      { schema: {}, mode: 'strict' },
      ['mode'],
    ],
    [
      'POST',
      '/collections/docs/schema/analyze',
      { sample_size: 1, limit: 2 },
      ['limit'],
    ],
  ])(
    'the remaining endpoints are judged too: %s %s',
    (method, path, body, expected) => {
      expect(refused(method, path, body)).toEqual(expected);
    }
  );
});
