/**
 * 400 INVALID_FILTER and INVALID_REQUEST_FIELD.
 *
 * The API judges the keys of every filter and the members of every request
 * body. The answer names the key's path (`field`), the key and the nearest
 * valid key (`suggestion`); the SDK carries all three. The path is read from
 * inside `error`, where the API puts it.
 */
import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import {
  InvalidFilterError,
  InvalidRequestFieldError,
  ValidationError,
  createErrorFromResponse,
} from '../../src/exceptions';
import { serializeFilter } from '../../src/utils/filter';
import { TEST_WORKSPACE_ID } from '../setup';

const BASE = 'https://vectors.aetherfy.com';
const PATH = `/api/v1/workspace-ids/${TEST_WORKSPACE_ID}/collections/docs/points/query`;

const INVALID_FILTER = {
  error: {
    code: 'INVALID_FILTER',
    message:
      "Unrecognised filter key 'mustnot' at filter.mustnot. Did you mean 'must_not'?",
    field: 'filter.mustnot',
    key: 'mustnot',
    suggestion: 'must_not',
  },
};
const INVALID_REQUEST_FIELD = {
  error: {
    code: 'INVALID_REQUEST_FIELD',
    message:
      "Unrecognised request field 'fitler' at fitler. Did you mean 'filter'?",
    field: 'fitler',
    key: 'fitler',
    suggestion: 'filter',
  },
};

function client(): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    enableConnectionPooling: false,
  });
}

afterEach(() => {
  nock.cleanAll();
});

describe('the mapping', () => {
  it('INVALID_FILTER carries the path, the key and the suggestion', () => {
    const error = createErrorFromResponse(
      INVALID_FILTER,
      400,
      'Bad Request'
    ) as InvalidFilterError;
    expect(error.constructor).toBe(InvalidFilterError);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.field).toBe('filter.mustnot');
    expect(error.key).toBe('mustnot');
    expect(error.suggestion).toBe('must_not');
    expect(error.code).toBe('INVALID_FILTER');
    expect(error.message).toContain("Did you mean 'must_not'");
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual(INVALID_FILTER.error);
    expect(error.toJSON()).toMatchObject({
      field: 'filter.mustnot',
      key: 'mustnot',
      suggestion: 'must_not',
    });
  });

  it('a filter error without a close key has no suggestion', () => {
    const { suggestion: _dropped, ...rest } = INVALID_FILTER.error;
    const error = createErrorFromResponse(
      { error: rest },
      400,
      'Bad Request'
    ) as InvalidFilterError;
    expect(error.constructor).toBe(InvalidFilterError);
    expect(error.suggestion).toBeUndefined();
    expect(error.key).toBe('mustnot');
  });

  it('INVALID_REQUEST_FIELD carries the path, the key and the suggestion', () => {
    const error = createErrorFromResponse(
      INVALID_REQUEST_FIELD,
      400,
      'Bad Request'
    ) as InvalidRequestFieldError;
    expect(error.constructor).toBe(InvalidRequestFieldError);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).not.toBeInstanceOf(InvalidFilterError);
    expect(error.field).toBe('fitler');
    expect(error.key).toBe('fitler');
    expect(error.suggestion).toBe('filter');
  });

  it('a member the streaming upsert does not support carries field and key', () => {
    const error = createErrorFromResponse(
      {
        error: {
          code: 'INVALID_REQUEST_FIELD',
          message: 'Conditional upserts (update_filter) are not supported.',
          field: 'update_filter',
          key: 'update_filter',
        },
      },
      400,
      'Bad Request'
    ) as InvalidRequestFieldError;
    expect(error.constructor).toBe(InvalidRequestFieldError);
    expect([error.field, error.key, error.suggestion]).toEqual([
      'update_filter',
      'update_filter',
      undefined,
    ]);
  });

  it('the two errors are siblings under ValidationError', () => {
    expect(InvalidFilterError.prototype).not.toBeInstanceOf(
      InvalidRequestFieldError
    );
    expect(InvalidRequestFieldError.prototype).not.toBeInstanceOf(
      InvalidFilterError
    );
  });

  it('a plain 400 reads field and violations from inside error', () => {
    const error = createErrorFromResponse(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'x',
          field: 'limit',
          violations: ['too big'],
        },
      },
      400,
      'Bad Request'
    ) as ValidationError;
    expect(error.constructor).toBe(ValidationError);
    expect(error.field).toBe('limit');
    expect(error.violations).toEqual(['too big']);
  });
});

describe('through the client', () => {
  it('search with a misspelt filter key throws the typed error', async () => {
    nock(BASE).post(PATH).reply(400, INVALID_FILTER);
    const error = await client()
      .search('docs', [0.1, 0.2], {
        queryFilter: { mustnot: [] } as never,
      })
      .catch(e => e);
    expect(error).toBeInstanceOf(InvalidFilterError);
    expect(error.suggestion).toBe('must_not');
  });

  it('the request carried the key as written (the API judges it)', async () => {
    let sent: Record<string, unknown> | undefined;
    nock(BASE)
      .post(PATH, b => {
        sent = b as Record<string, unknown>;
        return true;
      })
      .reply(400, INVALID_FILTER);
    await client()
      .search('docs', [0.1, 0.2], { queryFilter: { mustnot: [] } as never })
      .catch(() => undefined);
    expect(sent?.filter).toEqual({ mustnot: [] });
  });
});

describe('an upsert goes through the same mapping', () => {
  it('a 400 INVALID_REQUEST_FIELD arrives typed, with the whole body', async () => {
    const collection = `/api/v1/workspace-ids/${TEST_WORKSPACE_ID}/collections/docs`;
    nock(BASE)
      .get(collection)
      .reply(200, {
        result: {
          config: { params: { vectors: { size: 3, distance: 'Cosine' } } },
        },
        schema_version: 'v1',
      });
    nock(BASE)
      .get(`${collection}/schema`)
      .reply(404, { error: { code: 'SCHEMA_NOT_DEFINED', message: 'x' } });
    const refusal = {
      error: {
        code: 'INVALID_REQUEST_FIELD',
        message: 'Conditional upserts (update_filter) are not supported.',
        field: 'update_filter',
        key: 'update_filter',
      },
    };
    nock(BASE).put(`${collection}/points`).reply(400, refusal);

    const error = await client()
      .upsert('docs', [{ id: 1, vector: [0.1, 0.2, 0.3] }])
      .catch(e => e);
    expect(error).toBeInstanceOf(InvalidRequestFieldError);
    expect(error.field).toBe('update_filter');
    expect(error.key).toBe('update_filter');
    expect(error.code).toBe('INVALID_REQUEST_FIELD');
    expect(error.details).toEqual(refusal.error);
  });
});

describe('the filter the SDK serializes', () => {
  const COND = [{ key: 'a', match: { value: 1 } }];

  it('translates the camelCase clauses, minShould included', () => {
    const minShould = { conditions: COND, min_count: 1 };
    expect(
      serializeFilter(
        { must: COND, mustNot: COND, should: COND, minShould },
        'search'
      )
    ).toEqual({
      must: COND,
      must_not: COND,
      should: COND,
      min_should: minShould,
    });
  });

  it('keeps a fixed key order', () => {
    const out = serializeFilter(
      {
        minShould: { conditions: COND, min_count: 1 },
        should: COND,
        mustNot: COND,
        must: COND,
      },
      'search'
    );
    expect(Object.keys(out as object)).toEqual([
      'must',
      'must_not',
      'should',
      'min_should',
    ]);
  });

  it('forwards a key it does not translate, as written, after the known ones', () => {
    const out = serializeFilter(
      { nope: [], must: COND, must_not: COND } as never,
      'count'
    );
    expect(Object.keys(out as object)).toEqual(['must', 'nope', 'must_not']);
  });

  it('refuses only a filter that is not an object', () => {
    expect(() => serializeFilter([] as never, 'search')).toThrow(
      /filter must be an object/
    );
  });
});
