/**
 * Unit tests for createFieldIndex / deleteFieldIndex.
 *
 * The payload-index route has existed on the backend (and replicated) for a
 * while — `PUT /collections/{name}/index` and
 * `DELETE /collections/{name}/index/{field_name}`, both on the catch-all
 * allowlist and in the proxy's replicationEndpoints — but neither vectors SDK
 * exposed it. Filtering on an unindexed key is a SCAN, not a lookup, so an SDK
 * that can create a tenant key but not index it hands the customer a
 * collection that gets slower with every tenant.
 *
 * Parity file with the Python SDK's tests/test_field_index.py.
 */

import nock from 'nock';
import {
  AetherfyVectorsClient,
  INDEX_CREATE_ATTEMPT_TIMEOUT_MS,
  INDEX_FORWARD_MARGIN_MS,
  INDEX_WAIT_BUDGET_MS,
} from '../../src/client';
import {
  AetherfyVectorsError,
  RequestTimeoutError,
  ValidationError,
} from '../../src/exceptions';

const HOST = 'https://vectors.aetherfy.com';

// What the server answers once the index is built (Qdrant's own shape, relayed
// by vectordb, which sends index writes with ?wait=true) ...
const COMPLETED = {
  result: { operation_id: 7, status: 'completed' },
  status: 'ok',
};
// ... and what it answers when the build outlived its 25 s wait: HTTP 200, the
// build still running (vectordb services/proxy.js, db26396).
const ACKNOWLEDGED = {
  result: { operation_id: null, status: 'acknowledged' },
  status: 'ok',
  time: 25.0,
};

function newClient(workspace?: string): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    enableConnectionPooling: false,
    ...(workspace ? { workspace } : {}),
  });
}

describe('createFieldIndex', () => {
  afterEach(() => nock.cleanAll());

  it('PUTs field_name and field_schema to the index route', async () => {
    let seen: unknown;
    const scope = nock(HOST)
      .put('/api/v1/collections/articles/index', body => {
        seen = body;
        return true;
      })
      .reply(200, COMPLETED);

    await expect(
      newClient().createFieldIndex('articles', 'thread_id')
    ).resolves.toBe(true);

    expect(seen).toEqual({
      field_name: 'thread_id',
      field_schema: 'keyword',
    });
    scope.done();
  });

  it('forwards the schema verbatim', async () => {
    let seen: Record<string, unknown> = {};
    const scope = nock(HOST)
      .put('/api/v1/collections/articles/index', body => {
        seen = body as Record<string, unknown>;
        return true;
      })
      .reply(200, COMPLETED);

    await newClient().createFieldIndex('articles', 'flag', 'bool');
    expect(seen.field_schema).toBe('bool');
    scope.done();
  });

  it('forwards a parameterised schema object verbatim', async () => {
    let seen: Record<string, unknown> = {};
    const scope = nock(HOST)
      .put('/api/v1/collections/articles/index', body => {
        seen = body as Record<string, unknown>;
        return true;
      })
      .reply(200, COMPLETED);

    const schema = { type: 'text', tokenizer: 'word', lowercase: true };
    await newClient().createFieldIndex('articles', 'body', schema);
    expect(seen.field_schema).toEqual(schema);
    scope.done();
  });

  it('routes through the nested workspace URL', async () => {
    const scope = nock(HOST)
      .put('/api/v1/workspaces/team-alpha/collections/articles/index')
      .reply(200, COMPLETED);

    await newClient('team-alpha').createFieldIndex('articles', 'thread_id');
    scope.done();
  });

  it('rejects an empty field name locally', async () => {
    await expect(newClient().createFieldIndex('articles', '')).rejects.toThrow(
      ValidationError
    );
    // No interceptor was registered, so a request would have thrown a
    // NetworkError instead — the local rejection is what kept it off the wire.
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('rejects an invalid collection name locally', async () => {
    await expect(
      newClient().createFieldIndex('bad/name', 'thread_id')
    ).rejects.toThrow(ValidationError);
  });
});

describe('deleteFieldIndex', () => {
  afterEach(() => nock.cleanAll());

  it('DELETEs the field-scoped route', async () => {
    const scope = nock(HOST)
      .delete('/api/v1/collections/articles/index/thread_id')
      .reply(200, { result: true });

    await expect(
      newClient().deleteFieldIndex('articles', 'thread_id')
    ).resolves.toBe(true);
    scope.done();
  });

  it('URL-encodes a field name containing a separator', async () => {
    // The field name is one path segment; a '/' inside it must not become a
    // separator, or the request lands on a path the allowlist rejects.
    const scope = nock(HOST)
      .delete('/api/v1/collections/articles/index/metadata%2Ftag')
      .reply(200, { result: true });

    await newClient().deleteFieldIndex('articles', 'metadata/tag');
    scope.done();
  });

  it('returns false rather than throwing when the collection is gone', async () => {
    // The only 404 here is the collection's: a field that was never indexed
    // is answered 200 by the server, and so resolves true above.
    const scope = nock(HOST)
      .delete('/api/v1/collections/articles/index/thread_id')
      .reply(404, {
        error: {
          code: 'COLLECTION_NOT_FOUND',
          message: 'Collection articles not found',
        },
      });

    await expect(
      newClient().deleteFieldIndex('articles', 'thread_id')
    ).resolves.toBe(false);
    scope.done();
  });

  it('rejects an empty field name locally', async () => {
    await expect(newClient().deleteFieldIndex('articles', '')).rejects.toThrow(
      ValidationError
    );
  });
});

// ---------------------------------------------------------------------------
// The wait: vectordb waits up to 25 s for the build, then answers
// "acknowledged" while it carries on. Resolving true on that answer let an
// immediate scroll({ orderBy }) fail with "No range index for order_by key".
// Parity with the Python SDK's TestCreateWaitsUntilTheIndexIsBuilt.
// ---------------------------------------------------------------------------

/** A clock that only moves when the fake route says so. */
function fakeClock(): { now: number } {
  const clock = { now: 0 };
  jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
  return clock;
}

/**
 * The index route on the fake clock. Each create answers the next body in
 * `answers` (the last one repeats) after `cost` ms or, when the attempt's
 * timeout is shorter than that, fails at the timeout the way HttpClient's
 * transport does.
 */
function indexRoute(clock: { now: number }, answers: unknown[], cost = 25000) {
  const queue = [...answers];
  const attempts: Array<[number, number]> = [];
  const request = jest.fn(
    async (config: { timeout: number; body?: unknown }) => {
      attempts.push([clock.now, config.timeout]);
      if (config.timeout < cost) {
        clock.now += config.timeout;
        throw Object.assign(
          new Error(`Network error: timeout of ${config.timeout}ms exceeded`),
          { code: 'ECONNABORTED' }
        );
      }
      clock.now += cost;
      const data = queue.length > 1 ? queue.shift() : queue[0];
      return { status: 200, statusText: 'OK', headers: {}, data };
    }
  );
  return { request, attempts };
}

function onRoute(
  route: ReturnType<typeof indexRoute>,
  timeout?: number
): AetherfyVectorsClient {
  const client = new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    enableConnectionPooling: false,
    ...(timeout !== undefined ? { timeout } : {}),
  });
  (client as unknown as { httpClient: unknown }).httpClient = {
    request: route.request,
  };
  return client;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e
  );
}

describe('createFieldIndex resolves only once the index is built', () => {
  afterEach(() => jest.restoreAllMocks());

  it('acknowledged then completed is one more create', async () => {
    const clock = fakeClock();
    const route = indexRoute(clock, [ACKNOWLEDGED, COMPLETED]);

    await expect(
      onRoute(route).createFieldIndex('articles', 'ts', 'integer')
    ).resolves.toBe(true);

    // The second create is the same request: re-issuing it is what waits for
    // the running build.
    expect(route.attempts).toHaveLength(2);
    expect(route.request.mock.calls.map(c => c[0].body)).toEqual([
      { field_name: 'ts', field_schema: 'integer' },
      { field_name: 'ts', field_schema: 'integer' },
    ]);
  });

  it('completed at once is one create', async () => {
    const clock = fakeClock();
    const route = indexRoute(clock, [COMPLETED], 10);

    await expect(
      onRoute(route).createFieldIndex('articles', 'ts', 'integer')
    ).resolves.toBe(true);
    expect(route.attempts).toHaveLength(1);
  });

  it('always acknowledged stops at the deadline, never true', async () => {
    const clock = fakeClock();
    const route = indexRoute(clock, [ACKNOWLEDGED]);

    const error = await rejection(
      onRoute(route).createFieldIndex('articles', 'ts', 'integer', {
        timeout: 60000,
      })
    );

    // 0 s: given all 60 s, acknowledged at 25 s. 25 s: given the 35 s left,
    // acknowledged at 50 s. 50 s: given the last 10 s, and cut by the
    // deadline while the server is still waiting on the build.
    expect(route.attempts).toEqual([
      [0, 60000],
      [25000, 35000],
      [50000, 10000],
    ]);
    expect(clock.now).toBe(60000);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toBe(
      "The payload index on 'ts' in collection 'articles' is still building " +
        'after the 60000 ms deadline. The build carries on server-side; ' +
        'calling createFieldIndex again waits for it.'
    );
    expect((error as RequestTimeoutError).timeoutMs).toBe(60000);
  });

  it('a deadline reached between creates is still building, and sends no more', async () => {
    const clock = fakeClock();
    const route = indexRoute(clock, [ACKNOWLEDGED]);

    await expect(
      onRoute(route).createFieldIndex('articles', 'ts', 'integer', {
        timeout: 25000,
      })
    ).rejects.toThrow(/still building/);
    expect(route.attempts).toEqual([[0, 25000]]);
  });

  it('a deadline that cuts the first create does not claim a build', async () => {
    // No answer came back, so it is not known the create was taken.
    const clock = fakeClock();
    const route = indexRoute(clock, [COMPLETED]);

    const error = await rejection(
      onRoute(route).createFieldIndex('articles', 'ts', 'integer', {
        timeout: 5000,
      })
    );

    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toBe(
      "The payload index create on 'ts' in collection 'articles' got no " +
        'answer within the 5000 ms deadline, so it is not known whether it ' +
        'was taken. Calling createFieldIndex again is safe.'
    );
    expect(route.attempts).toEqual([[0, 5000]]);
  });

  it.each([
    ['no result', {}],
    ['bare true', { result: true }],
    ['another status', { result: { status: 'clock_rejected' } }],
  ])(
    'any other answer (%s) rejects rather than resolving true',
    async (_case, body) => {
      const clock = fakeClock();
      const route = indexRoute(clock, [body], 10);

      const error = await rejection(
        onRoute(route).createFieldIndex('articles', 'ts', 'integer')
      );
      expect(error).toBeInstanceOf(AetherfyVectorsError);
      expect((error as Error).message).toMatch(/not confirmed built/);
      expect(route.attempts).toHaveLength(1);
    }
  );
});

describe('createFieldIndex attempt timeout', () => {
  afterEach(() => jest.restoreAllMocks());

  // One create may be held for the server's whole wait budget, plus a forward
  // to a hosting region. An HTTP timeout shorter than that gives up before the
  // server's own answer arrives.
  it('outlasts the server wait and a forward', () => {
    // INDEX_WAIT_BUDGET_MS mirrors vectordb backend/config/timeouts.js
    // INDEX_WAIT_BUDGET_MS, and INDEX_FORWARD_MARGIN_MS its FORWARD_MARGIN_MS.
    // No cross-repo gate reads those; the comment on the constants says to
    // copy a change.
    expect(INDEX_WAIT_BUDGET_MS).toBe(25000);
    expect(INDEX_FORWARD_MARGIN_MS).toBe(5000);
    // With room for this client's own hop on top.
    const held = INDEX_WAIT_BUDGET_MS + INDEX_FORWARD_MARGIN_MS;
    expect(INDEX_CREATE_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(
      held + 10000
    );
    // The client-wide default alone does not leave that room, which is why
    // the create does not use it.
    const defaultTimeout = (
      AetherfyVectorsClient as unknown as { DEFAULT_TIMEOUT: number }
    ).DEFAULT_TIMEOUT;
    expect(defaultTimeout).toBeLessThan(held + 10000);
  });

  it('gives each create without a deadline the index attempt timeout', async () => {
    const clock = fakeClock();
    const route = indexRoute(clock, [ACKNOWLEDGED, COMPLETED]);

    await onRoute(route, 10000).createFieldIndex('articles', 'ts', 'integer');
    expect(route.attempts.map(([, given]) => given)).toEqual([
      INDEX_CREATE_ATTEMPT_TIMEOUT_MS,
      INDEX_CREATE_ATTEMPT_TIMEOUT_MS,
    ]);
  });

  it('keeps a longer client timeout', async () => {
    const clock = fakeClock();
    const route = indexRoute(clock, [COMPLETED]);

    await onRoute(route, 90000).createFieldIndex('articles', 'ts', 'integer');
    expect(route.attempts.map(([, given]) => given)).toEqual([90000]);
  });
});
