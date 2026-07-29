/**
 * Wire-level contract for SearchOptions.searchParams.
 *
 * The backend forwards the search body verbatim to Qdrant (raw-body
 * passthrough on POST /points/search), so `params` is a pure serialization
 * contract: what the SDK puts in the body is what the engine gets. These
 * tests pin the serialized bytes, not search behavior — no live search
 * needed.
 *
 * Two invariants matter beyond "it's in there":
 *
 *   1. The default body must not change shape. Server cache keys are derived
 *      from the request body BYTES; a new key (even one carrying null) would
 *      invalidate every cached search entry in the fleet on deploy.
 *   2. Unknown options must throw. TypeScript's excess-property check only
 *      fires on fresh object literals, so an options variable, an `as any`
 *      cast, or any untyped JS caller could pass `{ hnswEf: 256 }` and have
 *      it silently dropped — the same silent-drop that hid this gap on the
 *      Python side.
 */

import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { SearchOptions } from '../../src/models';

const BASE = 'https://vectors.aetherfy.com';
const PATH = '/api/v1/collections/test-collection/points/search';
const QUERY_VECTOR = [0.1, 0.2, 0.3];

/**
 * The body a default search() has always produced, as a literal — not built
 * from the client, so a client change shows up as a diff here rather than a
 * self-fulfilling assertion. Key order is part of the contract: the server
 * cache key is byte-derived.
 */
const BASELINE_BODY = JSON.stringify({
  vector: QUERY_VECTOR,
  limit: 10,
  offset: 0,
  with_payload: true,
  with_vector: false,
});

function makeClient(): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    enableConnectionPooling: false,
  });
}

/**
 * Run one search and return the RAW request body string nock saw. Raw, not
 * parsed: key order and the presence/absence of keys are what the server
 * hashes into a cache key.
 */
async function captureSearchBody(
  client: AetherfyVectorsClient,
  options: SearchOptions
): Promise<string> {
  let raw = '';
  const scope = nock(BASE)
    .post(PATH, body => {
      raw = typeof body === 'string' ? body : JSON.stringify(body);
      return true;
    })
    .reply(200, { result: [] });

  await client.search('test-collection', QUERY_VECTOR, options);
  scope.done();
  return raw;
}

describe('search searchParams — wire contract', () => {
  let client: AetherfyVectorsClient;

  beforeEach(() => {
    nock.cleanAll();
    client = makeClient();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('serialization', () => {
    it('sends searchParams verbatim as the body params field', async () => {
      const raw = await captureSearchBody(client, {
        searchParams: { hnsw_ef: 256 },
      });

      expect(JSON.parse(raw).params).toEqual({ hnsw_ef: 256 });
    });

    it('does not enumerate or translate param names', async () => {
      // The SDK must not know the schema. An arbitrary key it has never heard
      // of — including one Qdrant may add tomorrow — passes through intact,
      // snake_case and nesting preserved. If this test ever needs updating
      // for a new param name, the pass-through has grown an allowlist and
      // become a compatibility treadmill.
      const opaque = {
        hnsw_ef: 512,
        exact: false,
        quantization: { rescore: true, oversampling: 2.0 },
        some_param_invented_after_this_sdk_shipped: ['a', 1, null],
      };

      const raw = await captureSearchBody(client, { searchParams: opaque });

      expect(JSON.parse(raw).params).toEqual(opaque);
    });

    it('coexists with filter, threshold and limit', async () => {
      const queryFilter = {
        must: [{ key: 'category', match: { value: 'test' } }],
      };

      const raw = await captureSearchBody(client, {
        limit: 5,
        queryFilter,
        scoreThreshold: 0.7,
        searchParams: { hnsw_ef: 128 },
      });

      const body = JSON.parse(raw);
      expect(body.limit).toBe(5);
      expect(body.filter).toEqual(queryFilter);
      expect(body.score_threshold).toBe(0.7);
      expect(body.params).toEqual({ hnsw_ef: 128 });
    });
  });

  describe('default body unchanged', () => {
    it('omitting searchParams produces the byte-identical baseline body', async () => {
      const raw = await captureSearchBody(client, {});

      expect(raw).toBe(BASELINE_BODY);
    });

    it('no options argument at all produces the same baseline body', async () => {
      let raw = '';
      const scope = nock(BASE)
        .post(PATH, body => {
          raw = typeof body === 'string' ? body : JSON.stringify(body);
          return true;
        })
        .reply(200, { result: [] });

      await client.search('test-collection', QUERY_VECTOR);
      scope.done();

      expect(raw).toBe(BASELINE_BODY);
    });

    it('omits the params key entirely rather than sending null', async () => {
      // Not `"params": null`, not `"params": {}` — absent. A null would
      // change the body bytes and reach Qdrant as an explicit null.
      const raw = await captureSearchBody(client, { limit: 10 });

      expect(raw).not.toContain('params');
      expect(Object.keys(JSON.parse(raw))).not.toContain('params');
    });

    it('explicit undefined is the same as omitting', async () => {
      // Callers threading an optional through get the default path, not a
      // null on the wire.
      const raw = await captureSearchBody(client, { searchParams: undefined });

      expect(raw).toBe(BASELINE_BODY);
    });

    it('an empty object is sent as given, and is not the default body', async () => {
      // `{}` is a value, not an absence: the SDK does not second-guess it.
      // It is a different body, hence a different cache entry — which is why
      // the default path keys off `undefined`, not falsiness.
      const raw = await captureSearchBody(client, { searchParams: {} });

      expect(JSON.parse(raw).params).toEqual({});
      expect(raw).not.toBe(BASELINE_BODY);
    });
  });

  describe('cache-key divergence', () => {
    // Different params ⇒ different body ⇒ different server cache entry.
    // Documented behavior, not a bug: the same query at ef=64 and ef=256 must
    // never serve each other's results. The SDK's only obligation is to make
    // the bytes differ.
    it('different hnsw_ef produces different body bytes', async () => {
      const low = await captureSearchBody(client, {
        searchParams: { hnsw_ef: 64 },
      });
      const high = await captureSearchBody(client, {
        searchParams: { hnsw_ef: 256 },
      });

      expect(low).not.toBe(high);
    });

    it('the same hnsw_ef produces identical body bytes', async () => {
      // The flip side: identical params must hit the same cache entry, so
      // repeating the call must not perturb the bytes.
      const first = await captureSearchBody(client, {
        searchParams: { hnsw_ef: 256 },
      });
      const second = await captureSearchBody(client, {
        searchParams: { hnsw_ef: 256 },
      });

      expect(first).toBe(second);
    });
  });

  describe('unknown options throw', () => {
    // The JS analogue of Python's **kwargs sink. Types alone don't cover it:
    // excess-property checking is literal-only, and the package ships to
    // untyped JS consumers.
    it('rejects an unknown option passed via an options variable', async () => {
      // No `as any` here — a variable of a wider type is enough to slip past
      // TypeScript's excess-property check, which is precisely the realistic
      // footgun.
      const options: Record<string, unknown> = { limit: 5, hnswEf: 256 };

      await expect(
        client.search('test-collection', QUERY_VECTOR, options)
      ).rejects.toThrow(/search: unknown option\(s\): hnswEf/);
    });

    it('rejects the near-miss camelCase spelling of the new option', async () => {
      await expect(
        client.search('test-collection', QUERY_VECTOR, {
          hnsw_ef: 256,
        } as unknown as SearchOptions)
      ).rejects.toThrow(/unknown option\(s\): hnsw_ef/);
    });

    it('points the caller at searchParams in the error message', async () => {
      await expect(
        client.search('test-collection', QUERY_VECTOR, {
          params: { hnsw_ef: 256 },
        } as unknown as SearchOptions)
      ).rejects.toThrow(/searchParams/);
    });

    it('throws before any request is made', async () => {
      // A typo must not burn a request or populate a cache entry under a body
      // the caller didn't mean.
      const scope = nock(BASE).post(PATH).reply(200, { result: [] });

      await expect(
        client.search('test-collection', QUERY_VECTOR, {
          nope: true,
        } as unknown as SearchOptions)
      ).rejects.toThrow(/unknown option/);

      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });

    it('accepts every documented option without throwing', async () => {
      // Guard against an over-tight allowlist silently breaking real callers.
      const raw = await captureSearchBody(client, {
        limit: 3,
        offset: 1,
        queryFilter: { must: [] },
        withPayload: false,
        withVectors: true,
        scoreThreshold: 0.5,
        searchParams: { hnsw_ef: 200 },
      });

      expect(JSON.parse(raw).params).toEqual({ hnsw_ef: 200 });
    });
  });
});
