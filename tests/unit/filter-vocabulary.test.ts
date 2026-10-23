/**
 * Wire-level contract for the Filter clause vocabulary.
 *
 * `must` and `should` are spelled identically in the SDK's camelCase
 * vocabulary and the API's snake_case one; `mustNot` and `minShould` are not,
 * and a `mustNot` forwarded as written used to be dropped by the engine
 * without a word.
 *
 * Three things are pinned here, and each maps to a way the bug could return:
 *
 *   1. SERIALIZATION. All four clauses reach the body under their wire
 *      names, in a fixed order. Order is part of the contract: the server
 *      cache key is derived from the request body BYTES.
 *
 *   2. LOUD FAILURE, FROM THE API. The SDK keeps no list of clause names: a
 *      key it does not translate is sent as written and the API refuses an
 *      unknown one (400 INVALID_FILTER, the key's path and the nearest valid
 *      key), which the SDK throws as InvalidFilterError. A list kept here
 *      could only lag the API: it refused `min_should` for as long as it
 *      existed.
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
import { TEST_WORKSPACE_ID } from '../setup';
import { AetherfyVectorsClient } from '../../src/client';
import { InvalidFilterError } from '../../src/exceptions';
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
  reply: Record<string, unknown> = { result: { points: [] } }
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

    it('sends a typo’d clause as written, for the API to judge', () => {
      // The API answers it with 400 INVALID_FILTER, the key's path and the
      // nearest valid key (invalid-filter.test.ts): the SDK keeps no list of
      // clause names that could lag it.
      expect(
        serializeFilter({ mustnot: MUST_NOT } as unknown as Filter, 'search')
      ).toEqual({ mustnot: MUST_NOT });
    });

    it('sends the wire spelling as written: it is a valid key', () => {
      expect(
        serializeFilter({ must_not: MUST_NOT } as unknown as Filter, 'search')
      ).toEqual({ must_not: MUST_NOT });
    });

    it('accepts minShould, which the API takes', () => {
      const minShould = { conditions: SHOULD, min_count: 1 };
      expect(serializeFilter({ minShould }, 'count')).toEqual({
        min_should: minShould,
      });
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
        `/api/v1/workspace-ids/${TEST_WORKSPACE_ID}/collections/test-collection/points/query`,
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
        `/api/v1/workspace-ids/${TEST_WORKSPACE_ID}/collections/test-collection/points/scroll`,
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
        `/api/v1/workspace-ids/${TEST_WORKSPACE_ID}/collections/test-collection/points/count`,
        c => c.count('test-collection', { countFilter: { mustNot: MUST_NOT } }),
        { result: { count: 0 } }
      );
      expect(JSON.parse(raw).filter).toEqual({ must_not: MUST_NOT });
    });

    it('delete-by-filter sends must_not on the wire', async () => {
      const raw = await captureBody(
        `/api/v1/workspace-ids/${TEST_WORKSPACE_ID}/collections/test-collection/points/delete`,
        c => c.delete('test-collection', { mustNot: MUST_NOT }),
        { result: true }
      );
      expect(JSON.parse(raw).filter).toEqual({ must_not: MUST_NOT });
    });

    it('a filterless search body is unchanged', async () => {
      const raw = await captureBody(
        `/api/v1/workspace-ids/${TEST_WORKSPACE_ID}/collections/test-collection/points/query`,
        c => c.search('test-collection', QUERY_VECTOR)
      );
      expect(raw).toBe(
        JSON.stringify({
          query: QUERY_VECTOR,
          limit: 10,
          offset: 0,
          with_payload: true,
          with_vector: false,
        })
      );
    });

    it('a typo reaching search is sent as written and the API refuses it', async () => {
      const client = makeClient();
      let sent: Record<string, unknown> | undefined;
      const scope = nock(BASE)
        .post(
          `/api/v1/workspace-ids/${TEST_WORKSPACE_ID}/collections/test-collection/points/query`,
          b => {
            sent = b as Record<string, unknown>;
            return true;
          }
        )
        .reply(400, {
          error: {
            code: 'INVALID_FILTER',
            message: "Unrecognised filter key 'mustnot'.",
            field: 'filter.mustnot',
            key: 'mustnot',
            suggestion: 'must_not',
          },
        });

      await expect(
        client.search('test-collection', QUERY_VECTOR, {
          queryFilter: { mustnot: MUST_NOT } as unknown as Filter,
        })
      ).rejects.toBeInstanceOf(InvalidFilterError);

      expect(scope.isDone()).toBe(true);
      expect(sent?.filter).toEqual({ mustnot: MUST_NOT });
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
