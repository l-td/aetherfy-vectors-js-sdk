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
  INDEX_ATTEMPT_TIMEOUT_MS,
  INDEX_DEFAULT_DEADLINE_MS,
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

/**
 * A clock that only moves when the fake route says so. onRoute() installs it
 * as the client's now() seam; the real one is performance.now().
 */
function fakeClock(): { now: number } {
  return { now: 0 };
}

/**
 * The index route on the fake clock. Each create answers the next body in
 * `answers` (the last one repeats) after `cost` ms or, when the attempt's
 * timeout is shorter than that, fails at the timeout the way HttpClient's
 * transport does. More than MAX_CREATES creates ends the test instead of
 * hanging it.
 */
const MAX_CREATES = 1000;

function indexRoute(clock: { now: number }, answers: unknown[], cost = 25000) {
  const queue = [...answers];
  const attempts: Array<[number, number]> = [];
  const pauses: number[] = [];
  const request = jest.fn(
    async (config: { timeout: number; body?: unknown }) => {
      if (attempts.length >= MAX_CREATES) {
        throw new Error(`test route: more than ${MAX_CREATES} creates`);
      }
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
  // The client's pause between creates, on the same clock.
  const pause = async (ms: number): Promise<void> => {
    pauses.push(ms);
    clock.now += ms;
  };
  return { request, attempts, pauses, pause, now: () => clock.now };
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
  (client as unknown as { pause: unknown }).pause = route.pause;
  (client as unknown as { now: unknown }).now = route.now;
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

    // 0 s: given 45 s (the per-create cap, under the 60 s left),
    // acknowledged at 25 s. 25 s: given the 35 s left, acknowledged at 50 s.
    // 50 s: given the last 10 s, and cut by the deadline while the server is
    // still waiting on the build. Each "acknowledged" was held the server's
    // full 25 s, so no pause was added between creates.
    expect(route.attempts).toEqual([
      [0, 45000],
      [25000, 35000],
      [50000, 10000],
    ]);
    expect(route.pauses).toEqual([]);
    expect(clock.now).toBe(60000);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toBe(
      "The payload index on 'ts' in collection 'articles' is still building " +
        'after the 60 s deadline. The build carries on server-side; ' +
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
        'answer within the 5 s deadline, so it is not known whether it ' +
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

// A server that answers "acknowledged" at once did not hold the create (a
// vectordb from before db26396 answers every create that way). Re-sending at
// once would hammer it, forever when no timeout was passed. Parity with the
// Python SDK's TestCreateIsNeverUnbounded.
describe('createFieldIndex is never unbounded', () => {
  afterEach(() => jest.restoreAllMocks());

  it('paces an instant acknowledged and ends at the default deadline', async () => {
    const clock = fakeClock();
    const route = indexRoute(clock, [ACKNOWLEDGED], 50);

    const error = await rejection(
      onRoute(route).createFieldIndex('articles', 'ts', 'integer')
    );

    // Pauses of 1, 2, 4, 8, then 10 s each: 9 creates start in the first
    // minute. With no floor it would be 1200 (one per 50 ms).
    const firstMinute = route.attempts.filter(([at]) => at < 60000);
    expect(firstMinute).toHaveLength(9);
    expect(route.pauses.slice(0, 6)).toEqual([
      1000, 2000, 4000, 8000, 10000, 10000,
    ]);
    expect(Math.max(...route.pauses)).toBe(10000);
    // And the call ends at the default deadline, not never.
    expect(clock.now).toBe(INDEX_DEFAULT_DEADLINE_MS);
    expect(route.attempts.length).toBeLessThan(70);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toBe(
      "The payload index on 'ts' in collection 'articles' is still building " +
        'after the 600 s deadline. The build carries on server-side; ' +
        'calling createFieldIndex again waits for it.'
    );
  });

  it('adds no pause for a server that holds each create', async () => {
    const clock = fakeClock();
    const route = indexRoute(clock, [
      ACKNOWLEDGED,
      ACKNOWLEDGED,
      ACKNOWLEDGED,
      COMPLETED,
    ]);

    await expect(
      onRoute(route).createFieldIndex('articles', 'ts', 'integer')
    ).resolves.toBe(true);
    expect(route.pauses).toEqual([]);
    expect(route.attempts.map(([at]) => at)).toEqual([0, 25000, 50000, 75000]);
  });

  it('the default deadline is ten minutes', () => {
    expect(INDEX_DEFAULT_DEADLINE_MS).toBe(600000);
  });
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
    expect(INDEX_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(held + 10000);
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
      INDEX_ATTEMPT_TIMEOUT_MS,
      INDEX_ATTEMPT_TIMEOUT_MS,
    ]);
  });

  it('keeps a longer client timeout', async () => {
    const clock = fakeClock();
    const route = indexRoute(clock, [COMPLETED]);

    await onRoute(route, 90000).createFieldIndex('articles', 'ts', 'integer');
    expect(route.attempts.map(([, given]) => given)).toEqual([90000]);
  });
});

// vectordb holds an index delete like a create (?wait=true, 25 s, and a
// forward from a region that does not host the collection). A delete given only
// the client's timeout gave up before the server's answer, and it is not
// retried, so the caller got a timeout for a delete that succeeded. Parity with
// the Python SDK's TestDeleteAttemptTimeout.
describe('deleteFieldIndex attempt timeout', () => {
  it('a delete the server holds 28 s succeeds', async () => {
    const clock = fakeClock();
    const route = indexRoute(clock, [{ result: true, status: 'ok' }], 28000);

    // The client's own timeout is 10 s, well under the hold.
    await expect(
      onRoute(route, 10000).deleteFieldIndex('articles', 'ts')
    ).resolves.toBe(true);
    expect(route.attempts).toEqual([[0, INDEX_ATTEMPT_TIMEOUT_MS]]);
    expect(route.request.mock.calls[0][0]).toMatchObject({ method: 'DELETE' });
  });

  it('is still one request', async () => {
    const clock = fakeClock();
    const route = indexRoute(clock, [{ result: true }], 60000);

    await expect(
      onRoute(route).deleteFieldIndex('articles', 'ts')
    ).rejects.toThrow();
    expect(route.attempts).toHaveLength(1);
  });
});

// A deadline of 0 or less used to reject "still building" without sending
// anything, claiming a build it never started. It is refused up front. Parity
// with the Python SDK's TestCreateTimeoutMustBePositive.
describe('createFieldIndex options.timeout must be positive', () => {
  it.each([
    ['0', 0, '0'],
    ['-1', -1, '-1'],
    ['-0.5', -0.5, '-0.5'],
    ['Infinity', Infinity, 'Infinity'],
    ['NaN', NaN, 'NaN'],
    ['a string', '60000', "'60000'"],
    ['true', true, 'true'],
  ])(
    '%s is refused naming the value, before any request',
    async (_c, bad, shown) => {
      const route = indexRoute(fakeClock(), [COMPLETED], 10);

      const error = await rejection(
        onRoute(route).createFieldIndex('articles', 'ts', 'integer', {
          timeout: bad as unknown as number,
        })
      );
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toBe(
        `options.timeout must be a finite number of milliseconds above 0, got ${shown}`
      );
      expect(route.attempts).toHaveLength(0);
    }
  );

  it('a small positive timeout is taken', async () => {
    const route = indexRoute(fakeClock(), [COMPLETED], 10);

    await expect(
      onRoute(route).createFieldIndex('a', 'ts', 'integer', { timeout: 500 })
    ).resolves.toBe(true);
  });
});

// The deadline and the held-or-not check run on performance.now(), which is
// monotonic. Date.now() is the wall clock: an NTP step or a VM resuming moves
// it, and with it every deadline measured on it.
describe('createFieldIndex keeps its time on the monotonic clock', () => {
  afterEach(() => jest.restoreAllMocks());

  it('ends at its deadline while the wall clock stands still', async () => {
    const clock = fakeClock();
    const route = indexRoute(clock, [ACKNOWLEDGED], 50);
    jest
      .spyOn(globalThis.performance, 'now')
      .mockImplementation(() => clock.now);
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const client = onRoute(route);
    // The real clock seam this time, not the test's.
    delete (client as unknown as { now?: unknown }).now;

    const error = await rejection(
      client.createFieldIndex('articles', 'ts', 'integer', { timeout: 60000 })
    );

    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect((error as Error).message).toMatch(/still building after the 60 s/);
    expect(clock.now).toBe(60000);
    expect(route.attempts.length).toBeLessThan(15);
  });
});
