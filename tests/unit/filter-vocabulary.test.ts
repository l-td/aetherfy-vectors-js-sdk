/**
 * Wire-level contract for the Filter clause vocabulary.
 *
 * Before this suite the SDK forwarded the caller's filter object to the
 * engine verbatim. `must` and `should` survived that only because they are
 * spelled identically in the SDK's camelCase vocabulary and the engine's
 * snake_case one. `mustNot` did not: the engine has no such key, so an
 * exclusion clause was silently dropped — no error, no warning, and the
 * points the caller meant to exclude came back in the results.
 *
 * Three things are pinned here, and each maps to a way the bug could return:
 *
 *   1. SERIALIZATION. All three clauses reach the body under their wire
 *      names, in a fixed order. Order is part of the contract: the server
 *      cache key is derived from the request body BYTES.
 *
 *   2. LOUD FAILURE. An unrecognized clause throws. TypeScript's
 *      excess-property check only fires on fresh object literals, so a
 *      pre-built variable, an `as any` cast, or any untyped JS caller can
 *      reach the wire with `{ mustnot: [...] }`. Silent forwarding is what
 *      hid the original defect.
 *
 *   3. COMPILE-LEVEL SHAPE. The uncast `mustNot` literal must typecheck,
 *      and the wire spelling `must_not` must NOT. The docs previously told
 *      readers to write `must_not` with an `as unknown as Filter` cast,
 *      because that was the only honest way to reach the engine. The cast
 *      is what this fix retires — if `mustNot` ever stops typechecking,
 *      or `must_not` starts, the cast comes back. ts-jest type-checks test
 *      files (tests/tsconfig.json), so the assertions below are enforced at
 *      compile time, not runtime.
 */

import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { Filter } from '../../src/models';
import { serializeFilter } from '../../src/utils/filter';

const BASE = 'https://vectors.aetherfy.com';
const QUERY_VECTOR = [0.1, 0.2, 0.3];

const MUST = [{ key: 'category', match: { value: 'books' } }];
const MUST_NOT = [{ key: 'in_stock', match: { value: false } }];
const SHOULD = [{ key: 'tag', match: { value: 'sale' } }];

function makeClient(): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    enableConnectionPooling: false,
  });
}

/** Run one request and return the RAW body string nock saw. */
async function captureBody(
  path: string,
  run: (client: AetherfyVectorsClient) => Promise<unknown>,
  reply: Record<string, unknown> = { result: [] }
): Promise<string> {
  const client = makeClient();
  let raw = '';
  const scope = nock(BASE)
    .post(path, body => {
      raw = typeof body === 'string' ? body : JSON.stringify(body);
      return true;
    })
    .reply(200, reply);

  await run(client);
  scope.done();
  return raw;
}

describe('Filter clause vocabulary — wire contract', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  describe('serializeFilter', () => {
    it('translates the full vocabulary, must_not included', () => {
      expect(
        serializeFilter(
          { must: MUST, mustNot: MUST_NOT, should: SHOULD },
          'search'
        )
      ).toEqual({ must: MUST, must_not: MUST_NOT, should: SHOULD });
    });

    it('emits a fixed key order regardless of caller insertion order', () => {
      // Byte-level, not deep-equal: the server cache key is body-derived, so
      // two callers writing the same clauses in different orders must produce
      // the same bytes or they occupy two cache entries for one query.
      const a = JSON.stringify(
        serializeFilter(
          { should: SHOULD, mustNot: MUST_NOT, must: MUST },
          'search'
        )
      );
      const b = JSON.stringify(
        serializeFilter(
          { must: MUST, should: SHOULD, mustNot: MUST_NOT },
          'search'
        )
      );
      expect(a).toBe(b);
      expect(a).toBe(
        JSON.stringify({ must: MUST, must_not: MUST_NOT, should: SHOULD })
      );
    });

    it('omits clauses the caller left unset', () => {
      expect(serializeFilter({ mustNot: MUST_NOT }, 'search')).toEqual({
        must_not: MUST_NOT,
      });
      expect(
        serializeFilter({ must: MUST, mustNot: undefined }, 'search')
      ).toEqual({ must: MUST });
    });

    it('passes undefined through so a filterless body keeps its bytes', () => {
      expect(serializeFilter(undefined, 'search')).toBeUndefined();
      expect(serializeFilter(null, 'search')).toBeUndefined();
    });

    it('throws on a typo’d clause rather than dropping it', () => {
      expect(() =>
        serializeFilter({ mustnot: MUST_NOT } as unknown as Filter, 'search')
      ).toThrow(/unknown filter clause\(s\): mustnot/);
    });

    it('throws on the wire spelling and names the SDK spelling', () => {
      expect(() =>
        serializeFilter({ must_not: MUST_NOT } as unknown as Filter, 'search')
      ).toThrow(/mustNot/);
    });

    it('names the method that was called', () => {
      expect(() =>
        serializeFilter({ nope: [] } as unknown as Filter, 'count')
      ).toThrow(/^count: unknown filter clause/);
    });

    it('rejects a non-object filter', () => {
      expect(() =>
        serializeFilter([MUST] as unknown as Filter, 'search')
      ).toThrow(/must be an object/);
    });
  });

  describe('call sites', () => {
    it('search sends must_not on the wire', async () => {
      const raw = await captureBody(
        '/api/v1/collections/test-collection/points/search',
        c =>
          c.search('test-collection', QUERY_VECTOR, {
            queryFilter: { must: MUST, mustNot: MUST_NOT, should: SHOULD },
          })
      );
      expect(JSON.parse(raw).filter).toEqual({
        must: MUST,
        must_not: MUST_NOT,
        should: SHOULD,
      });
    });

    it('scroll sends must_not on the wire', async () => {
      const raw = await captureBody(
        '/api/v1/collections/test-collection/points/scroll',
        c =>
          c.scroll('test-collection', {
            scrollFilter: { mustNot: MUST_NOT },
          }),
        { result: { points: [], next_page_offset: null } }
      );
      expect(JSON.parse(raw).filter).toEqual({ must_not: MUST_NOT });
    });

    it('count sends must_not on the wire', async () => {
      const raw = await captureBody(
        '/api/v1/collections/test-collection/points/count',
        c => c.count('test-collection', { countFilter: { mustNot: MUST_NOT } }),
        { result: { count: 0 } }
      );
      expect(JSON.parse(raw).filter).toEqual({ must_not: MUST_NOT });
    });

    it('delete-by-filter sends must_not on the wire', async () => {
      const raw = await captureBody(
        '/api/v1/collections/test-collection/points/delete',
        c => c.delete('test-collection', { mustNot: MUST_NOT }),
        { result: true }
      );
      expect(JSON.parse(raw).filter).toEqual({ must_not: MUST_NOT });
    });

    it('a filterless search body is unchanged', async () => {
      const raw = await captureBody(
        '/api/v1/collections/test-collection/points/search',
        c => c.search('test-collection', QUERY_VECTOR)
      );
      expect(raw).toBe(
        JSON.stringify({
          vector: QUERY_VECTOR,
          limit: 10,
          offset: 0,
          with_payload: true,
          with_vector: false,
        })
      );
    });

    it('a typo reaching search throws instead of shipping a dropped clause', async () => {
      const client = makeClient();
      const scope = nock(BASE)
        .post('/api/v1/collections/test-collection/points/search')
        .reply(200, { result: [] });

      await expect(
        client.search('test-collection', QUERY_VECTOR, {
          queryFilter: { mustnot: MUST_NOT } as unknown as Filter,
        })
      ).rejects.toThrow(/unknown filter clause/);

      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });
  });

  describe('compile-level shape (enforced by ts-jest, not at runtime)', () => {
    it('the uncast mustNot literal typechecks', () => {
      // No cast. This is the form the docs will move to; if the property is
      // ever renamed or removed, this file stops compiling.
      const filter: Filter = {
        must: MUST,
        mustNot: MUST_NOT,
        should: SHOULD,
      };
      expect(Object.keys(filter)).toEqual(['must', 'mustNot', 'should']);
    });

    it('an inline uncast literal typechecks at the call site', () => {
      // Fresh object literals are where TS's excess-property check fires, so
      // the inline form is the strictest version of the assertion above.
      const options = {
        queryFilter: { must: MUST, mustNot: MUST_NOT },
      } satisfies { queryFilter: Filter };
      expect(options.queryFilter.mustNot).toBe(MUST_NOT);
    });

    it('the wire spelling must_not is a compile error', () => {
      const filter: Filter = {
        // @ts-expect-error — must_not is the WIRE key, not the SDK key. If
        // this line ever compiles, the Filter type has grown the snake_case
        // property back and the two spellings have diverged again.
        must_not: MUST_NOT,
      };
      expect(filter).toBeDefined();
    });

    it('a typo’d clause is a compile error', () => {
      const filter: Filter = {
        // @ts-expect-error — mustnot is not a clause.
        mustnot: MUST_NOT,
      };
      expect(filter).toBeDefined();
    });
  });
});
