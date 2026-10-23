/**
 * Every request body the client builds, recorded from its HTTP layer.
 *
 * `recordRequestBodies()` drives each public method that sends a body, with its
 * options all set, against a mocked HTTP layer (nothing leaves the process), and
 * returns what was sent: `[{ name, method, route, body }]`, sorted. The routes are
 * the ones the API sees (`/collections/{name}/...`), the workspace prefix removed.
 *
 * `tests/fixtures/request-bodies.json` is that list, committed. A test holds the
 * client to the file (it fails when the file is stale), and the API's own tests
 * read the file and send each body through its request validation, so a body the
 * API would refuse is found where the API is, not by a hand-kept list here.
 *
 * A row whose `name` is in DELIBERATELY_INVALID is a body the API is MEANT to
 * refuse: the tests that check the typed errors send it on purpose.
 *
 * Regenerate with `npm run record:request-bodies`.
 */
import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { DistanceMetric, Filter } from '../../src/models';

export interface RequestBodyRow {
  name: string;
  method: string;
  route: string;
  body: Record<string, unknown>;
}

export const DELIBERATELY_INVALID: Record<string, string> = {
  'search/misspelt-filter-key': 'INVALID_FILTER',
  'search/unknown-search-param': 'INVALID_REQUEST_FIELD',
};

const BASE = 'https://vectors.aetherfy.com';
const CONDITION = [{ key: 'category', match: { value: 'books' } }];
const FILTER: Filter = {
  must: CONDITION,
  mustNot: [{ key: 'in_stock', match: { value: false } }],
  should: [{ key: 'tag', match: { value: 'sale' } }],
  minShould: { conditions: CONDITION, min_count: 1 },
};
// The shape the memory layer sends for a thread: a scope clause, a point-id
// selector and an exclusion of the marker point.
const THREAD_FILTER: Filter = {
  must: [{ key: 'thread_id', match: { value: 't1' } }, { has_id: [1, 2] }],
  mustNot: [{ key: 'thread_marker', match: { value: true } }],
};
const VECTOR = [0.1, 0.2];

function route(path: string): string {
  return path
    .replace(/^\/api\/v1/, '')
    .replace(/^\/workspace(s|-ids)\/[^/]+/, '');
}

export async function recordRequestBodies(): Promise<RequestBodyRow[]> {
  const sent: Array<{ method: string; route: string; body: unknown }> = [];
  const answer = function (
    this: { req: { path: string; method: string } },
    _uri: string,
    body: unknown
  ) {
    sent.push({
      method: this.req.method,
      route: route(this.req.path),
      body,
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
  const calls: Array<[string, () => Promise<unknown>]> = [
    [
      'search/all-options',
      () =>
        client.search('docs', VECTOR, {
          limit: 5,
          offset: 1,
          queryFilter: FILTER,
          withPayload: false,
          withVectors: true,
          scoreThreshold: 0.5,
          searchParams: { hnsw_ef: 64, exact: false, indexed_only: true },
        }),
    ],
    ['search/defaults', () => client.search('docs', VECTOR)],
    [
      'search/thread-filter',
      () => client.search('docs', VECTOR, { queryFilter: THREAD_FILTER }),
    ],
    [
      'search/misspelt-filter-key',
      () =>
        client.search('docs', VECTOR, {
          queryFilter: { mustnot: [] } as unknown as Filter,
        }),
    ],
    [
      'search/unknown-search-param',
      () => client.search('docs', VECTOR, { searchParams: { bogus: 1 } }),
    ],
    [
      'scroll/all-options',
      () =>
        client.scroll('docs', {
          limit: 5,
          offset: 3,
          scrollFilter: FILTER,
          withPayload: false,
          withVectors: true,
        }),
    ],
    [
      'scroll/thread-filter',
      () => client.scroll('docs', { scrollFilter: THREAD_FILTER }),
    ],
    [
      'count/all-options',
      () => client.count('docs', { countFilter: FILTER, exact: false }),
    ],
    [
      'count/thread-filter',
      () => client.count('docs', { countFilter: THREAD_FILTER }),
    ],
    ['delete/ids', () => client.delete('docs', [1, 2])],
    ['delete/filter', () => client.delete('docs', FILTER)],
    ['delete/thread-filter', () => client.delete('docs', THREAD_FILTER)],
    [
      'set-payload/key',
      () => client.setPayload('docs', { a: 1 }, [1], { key: 'nested' }),
    ],
    ['set-payload', () => client.setPayload('docs', { a: 1 }, [1])],
    ['overwrite-payload', () => client.overwritePayload('docs', { a: 1 }, [1])],
    ['delete-payload', () => client.deletePayload('docs', ['a'], [1])],
    ['merge-metadata', () => client.mergeMetadata('docs', 1, { a: 1 })],
    ['delete-metadata-keys', () => client.deleteMetadataKeys('docs', 1, ['a'])],
    [
      'retrieve',
      () =>
        client.retrieve('docs', [1], { withPayload: false, withVectors: true }),
    ],
    ['upsert', () => client.upsert('docs', [{ id: 1, vector: VECTOR }])],
    [
      'upsert/payload',
      () =>
        client.upsert('docs', [{ id: 2, vector: VECTOR, payload: { a: 'b' } }]),
    ],
    [
      'create-collection',
      () =>
        client.createCollection(
          'fresh',
          { size: 2, distance: DistanceMetric.COSINE },
          'd',
          ['us-east-1']
        ),
    ],
    [
      'create-collection/defaults',
      () =>
        client.createCollection('fresh', {
          size: 2,
          distance: DistanceMetric.COSINE,
        }),
    ],
    [
      'create-field-index',
      () => client.createFieldIndex('docs', 'tag', 'keyword'),
    ],
    [
      'set-schema',
      () =>
        client.setSchema(
          'docs',
          { fields: { name: { type: 'string', required: false } } },
          'strict',
          'd'
        ),
    ],
    ['analyze-schema', () => client.analyzeSchema('docs', 500)],
  ];

  const rows: RequestBodyRow[] = [];
  try {
    for (const [name, call] of calls) {
      const before = sent.length;
      try {
        await call();
      } catch {
        // a method whose answer the stub does not satisfy still sent its request
      }
      for (const s of sent.slice(before)) {
        if (s.body !== null && typeof s.body === 'object') {
          rows.push({
            name,
            method: s.method,
            route: s.route,
            body: s.body as Record<string, unknown>,
          });
        }
      }
    }
  } finally {
    nock.cleanAll();
  }
  rows.sort((a, b) =>
    `${a.name} ${a.method} ${a.route}`.localeCompare(
      `${b.name} ${b.method} ${b.route}`
    )
  );
  return rows;
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)])
    );
  }
  return value;
}

/** The file's text: keys sorted, two-space indent, a trailing newline. */
export function dumpRequestBodies(rows: RequestBodyRow[]): string {
  return JSON.stringify(sortKeys(rows), null, 2) + '\n';
}
