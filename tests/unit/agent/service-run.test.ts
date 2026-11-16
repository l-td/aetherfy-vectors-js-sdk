/**
 * `serviceRun()`: the handle a service's run handler uses to spawn, read, wait
 * on and cancel with THE RUN'S OWN KEY.
 *
 * Pinned against the run queue's contract: the platform sets `X-Aetherfy-Run`
 * (the run's id) and `X-Aetherfy-Run-Key` (the run's key) on the loopback call
 * to `POST /aetherfy/run`, and removes both from public requests. The
 * module-level functions are unchanged and keep reading `AETHERFY_API_KEY`.
 *
 * No network is touched except one loopback server on 127.0.0.1, which exists to
 * produce the real `IncomingHttpHeaders` a Node handler is handed.
 */

import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';

import {
  cancel,
  result,
  serviceRun,
  spawn,
  wait,
  WAIT_TIMEOUT_DEFAULT_SECONDS,
} from '../../../src/agent';
import type { HeaderSource, ServiceRun } from '../../../src/agent';
import {
  AgentError,
  NotARun,
  NotAServiceRun,
  NotRunningOnAgent,
  RunLineFull,
  RunNotFound,
  RunReadError,
} from '../../../src/agent/errors';

const RUN_ID = '77777777-7777-7777-7777-777777777777';
const CHILD_ID = '88888888-8888-8888-8888-888888888888';
const RUN_KEY = 'afy_run_key_for_this_run';
const RELEASE_KEY = 'afy_release_key_of_the_service';

const ACCEPTED = {
  spawn_id: CHILD_ID,
  job_id: null,
  child_agent_id: '33333333-3333-3333-3333-333333333333',
  workspace: 'research',
  region: 'us-east-1',
  status: 'waiting',
  position: 2,
  estimated_start: '~1s',
};
const RUN_BODY = {
  id: CHILD_ID,
  agent_id: '6f1c2b7e-0a2d-4f8e-9c31-2b0d5a7e4411',
  state: 'completed',
  is_ephemeral: true,
  result: { rows: 1 },
  has_result: true,
};
const CANCELLED = {
  run: { ...RUN_BODY, state: 'cancelled' },
  outcome: 'cancelled',
  message: 'done',
  cancelled_count: 1,
};

const realFetch = global.fetch;
let fetchMock: jest.Mock;

function reply(status: number, body: unknown): Response {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Each route answers with a plausible success, so one handle can be driven
 * through all four calls without queueing replies. */
function routed(url: string): Response {
  if (url.endsWith('/spawn')) return reply(202, ACCEPTED);
  if (url.endsWith('/cancel')) return reply(200, CANCELLED);
  return reply(200, RUN_BODY);
}

async function caught<T>(promise: Promise<unknown>): Promise<T> {
  return (await promise.catch(e => e)) as T;
}

const keyOf = (call: unknown[]): string =>
  (call[1] as { headers: { Authorization: string } }).headers.Authorization;

const runHeaders = (): Record<string, string> => ({
  'X-Aetherfy-Run': RUN_ID,
  'X-Aetherfy-Run-Key': RUN_KEY,
});

beforeEach(() => {
  // A service machine: the release's key in the environment, and the URLs the
  // platform injects.
  process.env.AETHERFY_API_URL = 'https://agents.aetherfy.com/api/v1';
  process.env.AETHERFY_SPAWN_URL =
    'https://agents.aetherfy.com/api/v1/agents/{id}/spawn';
  process.env.AETHERFY_AGENT_ID = 'the-service-agent';
  process.env.AETHERFY_API_KEY = RELEASE_KEY;

  fetchMock = jest
    .fn()
    .mockImplementation(async (url: string) => routed(String(url)));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.AETHERFY_API_URL;
  delete process.env.AETHERFY_SPAWN_URL;
  delete process.env.AETHERFY_AGENT_ID;
  delete process.env.AETHERFY_API_KEY;
});

/**
 * The headers Node hands a request handler, for a request a client sent with
 * these exact names: a real `IncomingHttpHeaders`, lower-cased by Node's own
 * parser. Over 127.0.0.1 only.
 */
async function nodeHeaders(
  sent: Record<string, string>
): Promise<IncomingHttpHeaders> {
  let seen: IncomingHttpHeaders = {};
  const server = createServer((req, res) => {
    seen = req.headers;
    res.end('ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: (server.address() as AddressInfo).port,
          headers: sent,
        },
        res => {
          res.resume();
          res.on('end', resolve);
        }
      );
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  return seen;
}

describe('reading the headers', () => {
  const MAPPINGS: Array<[string, () => HeaderSource | Promise<HeaderSource>]> =
    [
      ['a plain object, as sent', runHeaders],
      [
        'a plain object, lower case',
        () => ({ 'x-aetherfy-run': RUN_ID, 'x-aetherfy-run-key': RUN_KEY }),
      ],
      [
        'a plain object, upper case',
        () => ({ 'X-AETHERFY-RUN': RUN_ID, 'X-AETHERFY-RUN-KEY': RUN_KEY }),
      ],
      [
        'a plain object, mixed case',
        () => ({ 'x-AetherFY-run': RUN_ID, 'X-aetherfy-RUN-key': RUN_KEY }),
      ],
      [
        'a plain object holding arrays',
        () => ({ 'x-aetherfy-run': [RUN_ID], 'x-aetherfy-run-key': [RUN_KEY] }),
      ],
      ['a fetch Headers', () => new Headers(runHeaders())],
      [
        'a fetch Headers, lower case',
        () =>
          new Headers({
            'x-aetherfy-run': RUN_ID,
            'x-aetherfy-run-key': RUN_KEY,
          }),
      ],
      // The real thing: what `req.headers` is in a Node handler.
      [
        'Node IncomingHttpHeaders, sent as written',
        () => nodeHeaders(runHeaders()),
      ],
      [
        'Node IncomingHttpHeaders, sent in upper case',
        () =>
          nodeHeaders({
            'X-AETHERFY-RUN': RUN_ID,
            'X-AETHERFY-RUN-KEY': RUN_KEY,
          }),
      ],
    ];

  it.each(MAPPINGS)(
    'reads the run and its key from %s',
    async (_name, make) => {
      const handle = serviceRun(await make());

      expect(handle.run_id).toBe(RUN_ID);
      // What proves the key was read is what the handle SENDS.
      await handle.result(CHILD_ID);
      expect(keyOf(fetchMock.mock.calls[0])).toBe(`Bearer ${RUN_KEY}`);
    }
  );

  it.each([
    ['no headers', {}],
    [
      'unrelated headers',
      { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
    ],
    ['only the id', { 'X-Aetherfy-Run': RUN_ID }],
    ['only the key', { 'X-Aetherfy-Run-Key': RUN_KEY }],
    ['an empty id', { 'X-Aetherfy-Run': '', 'X-Aetherfy-Run-Key': RUN_KEY }],
    ['an empty key', { 'X-Aetherfy-Run': RUN_ID, 'X-Aetherfy-Run-Key': '' }],
    ['blank values', { 'X-Aetherfy-Run': '   ', 'X-Aetherfy-Run-Key': '  ' }],
    [
      'an undefined value',
      { 'X-Aetherfy-Run': RUN_ID, 'X-Aetherfy-Run-Key': undefined },
    ],
    [
      'an empty array',
      { 'X-Aetherfy-Run': [], 'X-Aetherfy-Run-Key': [RUN_KEY] },
    ],
    [
      'look-alike names',
      { 'X-Aetherfy-Run-Id': RUN_ID, 'X-Aetherfy-Run-Keys': RUN_KEY },
    ],
    [
      'names without the prefix',
      { 'Aetherfy-Run': RUN_ID, 'Aetherfy-Run-Key': RUN_KEY },
    ],
  ])('is not a service run with %s', (_name, headers) => {
    expect(() => serviceRun(headers as HeaderSource)).toThrow(NotAServiceRun);
  });

  it('is not a service run with the headers of a public request', () => {
    // What a browser or a curl sends. The platform removes the two headers from
    // public traffic, so a handler that gets here without them is not inside a
    // run.
    expect(() =>
      serviceRun(new Headers({ 'user-agent': 'curl/8', accept: '*/*' }))
    ).toThrow(NotAServiceRun);
  });

  it.each([
    [{}, ['X-Aetherfy-Run', 'X-Aetherfy-Run-Key']],
    [{ 'X-Aetherfy-Run': RUN_ID }, ['X-Aetherfy-Run-Key']],
    [{ 'x-aetherfy-run-key': RUN_KEY }, ['X-Aetherfy-Run']],
  ])('names the headers that were missing (%j)', (headers, missing) => {
    const error = (() => {
      try {
        serviceRun(headers);
      } catch (e) {
        return e as NotAServiceRun;
      }
      throw new Error('serviceRun did not throw');
    })();

    expect(error).toBeInstanceOf(AgentError);
    expect(error.missing).toEqual(missing);
    // What to do about it: the one place this is for, and why a public request
    // fails it.
    expect(error.message).toContain('POST /aetherfy/run');
    expect(error.message).toContain('public request');
  });
});

describe('the handle', () => {
  it('never shows its key', () => {
    const handle = serviceRun(runHeaders());

    expect(JSON.stringify(handle)).not.toContain(RUN_KEY);
    expect(inspect(handle, { depth: 5 })).not.toContain(RUN_KEY);
    expect(Object.values(handle).join(' ')).not.toContain(RUN_KEY);
    expect(inspect(handle)).toContain(RUN_ID);
  });

  it('cannot be altered after it is made', () => {
    const handle = serviceRun(runHeaders());

    expect(Object.isFrozen(handle)).toBe(true);
  });
});

describe('the key each call sends', () => {
  it("sends the run's key on every call through the handle", async () => {
    const handle = serviceRun(runHeaders());

    await handle.spawn('worker', { n: 1 });
    await handle.result(CHILD_ID);
    await handle.wait(CHILD_ID, 5);
    await handle.cancel(CHILD_ID);

    expect(fetchMock.mock.calls.map(c => c[1].method)).toEqual([
      'POST',
      'GET',
      'GET',
      'POST',
    ]);
    expect(fetchMock.mock.calls.map(keyOf)).toEqual(
      Array(4).fill(`Bearer ${RUN_KEY}`)
    );
  });

  it("sends the environment's key from the module-level functions", async () => {
    // UNCHANGED: in a service that is the release's key, right for the
    // service's own traffic.
    await spawn('worker', { n: 1 });
    await result(CHILD_ID);
    await wait(CHILD_ID, 5);
    await cancel(CHILD_ID);

    expect(fetchMock.mock.calls.map(keyOf)).toEqual(
      Array(4).fill(`Bearer ${RELEASE_KEY}`)
    );
  });

  it('never lets the two keys cross in one process', async () => {
    const handle = serviceRun(runHeaders());

    await Promise.all([
      handle.result(CHILD_ID),
      result(CHILD_ID),
      handle.result(CHILD_ID),
    ]);

    expect(fetchMock.mock.calls.map(keyOf).sort()).toEqual(
      [`Bearer ${RUN_KEY}`, `Bearer ${RELEASE_KEY}`, `Bearer ${RUN_KEY}`].sort()
    );
  });

  it('needs no key in the environment', async () => {
    // Its key is the run's, from the headers. The environment's key is neither
    // read nor required.
    delete process.env.AETHERFY_API_KEY;
    const handle = serviceRun(runHeaders());

    expect((await handle.result(CHILD_ID)).state).toBe('completed');
    expect(keyOf(fetchMock.mock.calls[0])).toBe(`Bearer ${RUN_KEY}`);
    await expect(result(CHILD_ID)).rejects.toBeInstanceOf(NotRunningOnAgent);
  });

  it('makes the same requests as the module-level functions', async () => {
    // SAME ENDPOINTS, BODIES AND TRANSPORT: only the key differs.
    const handle = serviceRun(runHeaders());
    const clone = (call: unknown[]) => {
      const init = call[1] as {
        headers: Record<string, string>;
        [key: string]: unknown;
      };
      const { headers, signal: _signal, ...rest } = init;
      const { Authorization: _key, ...otherHeaders } = headers;
      return [call[0], rest, otherHeaders];
    };

    await handle.spawn('worker', { n: 1 });
    await handle.result(CHILD_ID);
    await handle.wait(CHILD_ID, 45);
    await handle.cancel(CHILD_ID);
    await spawn('worker', { n: 1 });
    await result(CHILD_ID);
    await wait(CHILD_ID, 45);
    await cancel(CHILD_ID);

    const calls = fetchMock.mock.calls.map(clone);
    expect(calls.slice(0, 4)).toEqual(calls.slice(4));
  });

  it("has the module-level functions' signatures", () => {
    const handle: ServiceRun = serviceRun(runHeaders());

    expect(handle.spawn.length).toBe(spawn.length);
    expect(handle.result.length).toBe(result.length);
    expect(handle.cancel.length).toBe(cancel.length);
    // wait() has a default for its timeout, so both report the one required.
    expect(handle.wait.length).toBe(wait.length);
  });
});

describe('the same answers and the same errors', () => {
  it('returns the same shapes', async () => {
    const handle = serviceRun(runHeaders());

    const spawned = await handle.spawn('worker');
    expect(spawned.status).toBe('waiting');
    expect(spawned.position).toBe(2);
    expect(spawned.job_id).toBeNull();
    expect((await handle.result(CHILD_ID)).state).toBe('completed');
    expect((await handle.wait(CHILD_ID)).state).toBe('completed');
    expect((await handle.cancel(CHILD_ID)).outcome).toBe('cancelled');
  });

  it('throws the same errors', async () => {
    const handle = serviceRun(runHeaders());

    fetchMock.mockResolvedValueOnce(
      reply(429, {
        detail: { code: 'AGENT_RUN_LINE_FULL', message: 'full' },
      })
    );
    expect(await caught(handle.spawn('worker'))).toBeInstanceOf(RunLineFull);

    fetchMock.mockResolvedValueOnce(
      reply(404, {
        detail: { code: 'DEPLOYMENT_NOT_FOUND', message: 'no' },
      })
    );
    expect(await caught(handle.result(CHILD_ID))).toBeInstanceOf(RunNotFound);

    fetchMock.mockResolvedValueOnce(
      reply(409, {
        detail: { code: 'DEPLOYMENT_NOT_A_RUN', message: 'release' },
      })
    );
    expect(await caught(handle.cancel(CHILD_ID))).toBeInstanceOf(NotARun);
  });

  it.each([0, 61])(
    'checks the wait bound before sending (%i)',
    async timeout => {
      const handle = serviceRun(runHeaders());

      const error = await caught<AgentError>(handle.wait(CHILD_ID, timeout));

      expect(error).toBeInstanceOf(AgentError);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('waits the documented default when no timeout is given', async () => {
    await serviceRun(runHeaders()).wait(CHILD_ID);

    expect(fetchMock.mock.calls[0][0]).toContain(
      `?timeout_seconds=${WAIT_TIMEOUT_DEFAULT_SECONDS}`
    );
  });

  it("leaves a module-level wait on the run's child to the control plane to refuse", async () => {
    // What the docs warn about: a run spawned through the handle belongs to the
    // run's tree, so a module-level wait (the release's key) is refused by the
    // control plane. The helper reports the refusal as it came.
    fetchMock.mockResolvedValue(
      reply(403, {
        detail: {
          code: 'AUTH_AGENT_KEY_OUT_OF_SCOPE',
          message: "Wait through the run's handle: serviceRun(headers).",
        },
      })
    );

    const error = await caught<RunReadError>(wait(CHILD_ID, 5));

    expect(error).toBeInstanceOf(RunReadError);
    expect(error.code).toBe('AUTH_AGENT_KEY_OUT_OF_SCOPE');
    expect(keyOf(fetchMock.mock.calls[0])).toBe(`Bearer ${RELEASE_KEY}`);
  });
});
