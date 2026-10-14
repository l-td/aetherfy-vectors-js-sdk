/**
 * The retry rule (src/retry-policy.ts), driven through the client on the
 * wire. A refusal before anything ran is retried for every operation; an
 * ambiguous failure only for an operation whose repeat gives the same result;
 * a 4xx never. Each test queues what the wire returns and counts attempts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { DistanceMetric } from '../../src/models';
import {
  ONCE,
  OPERATIONS,
  REPEATABLE,
  REPEATABLE_DESPITE_ITS_NAME,
} from '../../src/retry-policy';

const BASE = 'https://vectors.aetherfy.com';
const WS = '/api/v1/workspaces/w';
const LOOKUP = {
  error: { code: 'WORKSPACE_LOOKUP_UNAVAILABLE', message: 'x' },
};
const OTHER_503 = { error: { code: 'SOMETHING_ELSE', message: 'x' } };

function client(): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    workspace: 'w',
    enableConnectionPooling: false,
  });
}

/** A transport failure as Node reports it. */
function transport(code: string, syscall?: string): Error {
  return Object.assign(new Error(`${code} (test)`), { code, syscall });
}

type Call = {
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  run: (c: AetherfyVectorsClient) => Promise<unknown>;
  ok: Record<string, unknown>;
};

const CALLS: Record<string, Call> = {
  getCollection: {
    method: 'get',
    path: `${WS}/collections/docs`,
    run: c => c.getCollection('docs'),
    ok: { result: { name: 'docs' } },
  },
  deleteCollection: {
    method: 'delete',
    path: `${WS}/collections/docs`,
    run: c => c.deleteCollection('docs'),
    ok: { result: true },
  },
  createCollection: {
    method: 'post',
    path: `${WS}/collections`,
    run: c =>
      c.createCollection('docs', { size: 3, distance: DistanceMetric.COSINE }),
    ok: { result: true },
  },
  count: {
    method: 'post',
    path: `${WS}/collections/docs/points/count`,
    run: c => c.count('docs'),
    ok: { result: { count: 1 } },
  },
  scroll: {
    method: 'post',
    path: `${WS}/collections/docs/points/scroll`,
    run: c => c.scroll('docs', { limit: 1 }),
    ok: { result: { points: [] } },
  },
  retrieve: {
    method: 'post',
    path: `${WS}/collections/docs/points/retrieve`,
    run: c => c.retrieve('docs', [1]),
    ok: { result: [] },
  },
};

/** Queue `failures` (each a status+body, or a transport error), then ok. */
function wire(
  call: Call,
  failures: Array<[number, unknown] | Error>,
  thenOk = true
): { attempts: () => number } {
  let attempts = 0;
  const s = nock(BASE);
  for (const f of failures) {
    const interceptor = s[call.method](call.path);
    if (f instanceof Error) {
      interceptor.replyWithError(f);
    } else {
      interceptor.reply(f[0], f[1] as Record<string, unknown>);
    }
  }
  if (thenOk) s[call.method](call.path).reply(200, call.ok);
  s.on('request', () => {
    attempts += 1;
  });
  return { attempts: () => attempts };
}

afterEach(() => nock.cleanAll());

describe('1. refused before anything ran: every operation', () => {
  it('a GET retries a lookup-unavailable 503', async () => {
    const w = wire(CALLS.getCollection, [[503, LOOKUP]]);
    await CALLS.getCollection.run(client());
    expect(w.attempts()).toBe(2);
  });

  it('a DELETE retries a lookup-unavailable 503', async () => {
    const w = wire(CALLS.deleteCollection, [[503, LOOKUP]]);
    await CALLS.deleteCollection.run(client());
    expect(w.attempts()).toBe(2);
  });

  it.each([
    ['ECONNREFUSED', undefined],
    ['ENOTFOUND', undefined],
    ['ETIMEDOUT', 'connect'],
  ])('a DELETE retries a connection never made (%s)', async (code, syscall) => {
    const w = wire(CALLS.deleteCollection, [transport(code, syscall)]);
    await CALLS.deleteCollection.run(client());
    expect(w.attempts()).toBe(2);
  });
});

describe('2. ambiguous: only operations whose repeat gives the same result', () => {
  it.each(['deleteCollection', 'createCollection'])(
    '%s does not retry a read timeout',
    async op => {
      const w = wire(CALLS[op], [transport('ECONNABORTED')]);
      await expect(CALLS[op].run(client())).rejects.toThrow();
      expect(w.attempts()).toBe(1);
    }
  );

  it.each(['deleteCollection', 'createCollection'])(
    '%s does not retry a reset or another 503',
    async op => {
      let w = wire(CALLS[op], [transport('ECONNRESET')]);
      await expect(CALLS[op].run(client())).rejects.toThrow();
      expect(w.attempts()).toBe(1);
      nock.cleanAll();

      w = wire(CALLS[op], [[503, OTHER_503]]);
      await expect(CALLS[op].run(client())).rejects.toThrow();
      expect(w.attempts()).toBe(1);
    }
  );

  it.each(['getCollection', 'count', 'scroll', 'retrieve'])(
    '%s retries a read timeout, a reset and another 503',
    async op => {
      for (const failure of [
        transport('ECONNABORTED'),
        transport('ECONNRESET'),
        [503, OTHER_503] as [number, unknown],
      ]) {
        const w = wire(CALLS[op], [failure]);
        await CALLS[op].run(client());
        expect(w.attempts()).toBe(2);
        nock.cleanAll();
      }
    }
  );

  it('an ambiguous failure is retried three times, then thrown', async () => {
    const w = wire(
      CALLS.count,
      [1, 2, 3, 4].map(() => transport('ECONNRESET')),
      false
    );
    await expect(CALLS.count.run(client())).rejects.toThrow();
    expect(w.attempts()).toBe(4);
  });
});

describe('3. a 4xx is never retried', () => {
  it.each(['getCollection', 'count', 'deleteCollection'])('%s', async op => {
    const w = wire(CALLS[op], [
      [400, { error: { code: 'VALIDATION_ERROR', message: 'x' } }],
    ]);
    await expect(CALLS[op].run(client())).rejects.toThrow();
    expect(w.attempts()).toBe(1);
  });
});

describe('the table is the call sites', () => {
  it('every request declares an operation of the table, and vice versa', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'src', 'client.ts'),
      'utf8'
    );
    const declared = new Set(
      [...source.matchAll(/this\.send\(\s*'([a-zA-Z]+)'/g)].map(m => m[1])
    );
    expect([...declared].sort()).toEqual(Object.keys(OPERATIONS).sort());
    expect(
      source.match(/this\.httpClient\.(get|post|put|delete|patch|request)[(<]/g)
        ?.length
    ).toBe(source.match(/this\.send\(/g)?.length);
  });

  it("the ruling's once operations are once", () => {
    for (const op of [
      'createCollection',
      'deleteCollection',
      'delete',
      'deleteSchema',
      'deleteFieldIndex',
    ] as const) {
      expect(OPERATIONS[op]).toBe(ONCE);
    }
    for (const op of [
      'search',
      'count',
      'scroll',
      'retrieve',
      'upsert',
      'setPayload',
      'overwritePayload',
      'createFieldIndex',
      'getCollection',
    ] as const) {
      expect(OPERATIONS[op]).toBe(REPEATABLE);
    }
  });
});

it('setSchema is repeatable only while it sends no If-Match', async () => {
  // A repeat of an If-Match write after a hidden success gets a false 412:
  // if setSchema ever sends If-Match, it must be classed ONCE.
  let ifMatch: unknown;
  nock(BASE)
    .put(`${WS}/collections/docs/schema`)
    .reply(function () {
      ifMatch = this.req.headers['if-match'];
      return [200, { etag: 'v1' }];
    });

  await client().setSchema('docs', { fields: {} });

  expect(OPERATIONS.setSchema).toBe(ifMatch === undefined ? REPEATABLE : ONCE);
});

describe('the wrong-class guard', () => {
  /** {operation: HTTP methods}, read from client.ts's send() call sites. */
  function httpMethodOfEachOperation(): Map<string, Set<string>> {
    const source = readFileSync(
      join(__dirname, '..', '..', 'src', 'client.ts'),
      'utf8'
    );
    const methods = new Map<string, Set<string>>();
    const sites = [...source.matchAll(/this\.send\(\s*'([a-zA-Z]+)'/g)];
    sites.forEach((site, i) => {
      const end = i + 1 < sites.length ? sites[i + 1].index : source.length;
      const body = source.slice(site.index, end);
      const call = body.match(
        /this\.httpClient\.(get|post|put|delete|patch|request)/
      );
      let verb = call ? call[1].toUpperCase() : '?';
      if (verb === 'REQUEST') {
        verb = body.match(/method:\s*'([A-Z]+)'/)?.[1] ?? '?';
      }
      const set = methods.get(site[1]) ?? new Set<string>();
      set.add(verb);
      methods.set(site[1], set);
    });
    return methods;
  }

  it('a delete or a create is ONCE unless listed with a reason', () => {
    const methods = httpMethodOfEachOperation();
    expect([...methods.keys()].sort()).toEqual(Object.keys(OPERATIONS).sort());
    for (const [op, verbs] of methods) {
      const risky =
        verbs.has('DELETE') ||
        op.startsWith('delete') ||
        op.startsWith('create');
      if (risky && !(op in REPEATABLE_DESPITE_ITS_NAME)) {
        expect([op, OPERATIONS[op as keyof typeof OPERATIONS]]).toEqual([
          op,
          ONCE,
        ]);
      }
    }
    for (const [op, reason] of Object.entries(REPEATABLE_DESPITE_ITS_NAME)) {
      expect(OPERATIONS[op as keyof typeof OPERATIONS]).toBe(REPEATABLE);
      expect(reason?.trim()).toBeTruthy();
    }
  });
});
