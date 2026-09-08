/**
 * `result()` and `wait()`: the run a caller reads back, and the refusals the
 * two routes answer identically.
 *
 * Pinned against aetherfy-control-plane `api/routes/deployments.py`:
 * `GET /deployments/{id}` and `GET /deployments/{id}/wait`, both returning
 * `DeploymentResponse`, both loading through `_load_customer_deployment` —
 * which is why a 404 and a 403 must arrive here identically whichever call was
 * made. The wait bound (1..60, default 30) is `WAIT_TIMEOUT_MIN_SECONDS` /
 * `WAIT_TIMEOUT_MAX_SECONDS` / `WAIT_TIMEOUT_DEFAULT_SECONDS` there.
 *
 * No network is touched — `fetch` is replaced.
 */

import {
  result,
  wait,
  WAIT_TIMEOUT_DEFAULT_SECONDS,
  WAIT_TIMEOUT_MAX_SECONDS,
  WAIT_TIMEOUT_MIN_SECONDS,
} from '../../../src/agent';
import {
  AgentError,
  AgentTransportError,
  NotRunningOnAgent,
  RunAccessDenied,
  RunNotFound,
  RunReadError,
  WaitTimeoutInvalid,
} from '../../../src/agent/errors';

const RUN_ID = '44444444-4444-4444-4444-444444444444';

// A finished run, exactly as DeploymentResponse serializes one — including the
// deploy-shaped fields a run carries but nobody reads off it, because `raw`
// promises the whole object.
const FINISHED = {
  id: RUN_ID,
  agent_id: '6f1c2b7e-0a2d-4f8e-9c31-2b0d5a7e4411',
  version: 7,
  state: 'completed',
  is_ephemeral: true,
  result: { rows: 128 },
  result_error: null,
  has_result: true,
  error_message: null,
  regions: ['iad'],
  pending_regions: [],
  created_at: '2026-09-08T09:04:11Z',
};

const realFetch = global.fetch;
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
let fetchMock: jest.Mock;
let timeoutSpy: jest.SpyInstance;

function reply(status: number, body: unknown): Response {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function refusal(
  code: string | null,
  message = 'nope',
  extras: Record<string, unknown> = {}
) {
  return { detail: { ...(code ? { code } : {}), message, ...extras } };
}

/**
 * The error a call rejected with, typed for assertion.
 *
 * `.catch((e) => e)` yields `unknown`, and every property read off it is a
 * compile error. The cast is the test's own claim about which type it expects;
 * the `toBeInstanceOf` beside it is what proves the claim.
 */
async function caught<T>(promise: Promise<unknown>): Promise<T> {
  return (await promise.catch(e => e)) as T;
}

beforeEach(() => {
  process.env.AETHERFY_API_URL = 'https://agents.aetherfy.com/api/v1';
  process.env.AETHERFY_API_KEY = 'afy_test_key';

  fetchMock = jest.fn().mockResolvedValue(reply(200, FINISHED));
  global.fetch = fetchMock as unknown as typeof fetch;
  // The only place the client's own deadline is observable: the signal itself
  // does not carry the milliseconds it was built with.
  timeoutSpy = jest
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation((ms: number) => realTimeout(ms));
});

afterEach(() => {
  global.fetch = realFetch;
  timeoutSpy.mockRestore();
  delete process.env.AETHERFY_API_URL;
  delete process.env.AETHERFY_API_KEY;
});

describe('the request', () => {
  it('reads the deployment route', async () => {
    await result(RUN_ID);

    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('GET');
    expect(url).toBe(
      `https://agents.aetherfy.com/api/v1/deployments/${RUN_ID}`
    );
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer afy_test_key');
    expect(init.headers['User-Agent']).toMatch(/^aetherfy-agent-js\//);
  });

  it('does not double a trailing slash on the base URL', async () => {
    process.env.AETHERFY_API_URL = 'https://agents.aetherfy.com/api/v1/';
    await result(RUN_ID);
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/deployments/');
  });

  it('sends the default timeout the server documents', async () => {
    await wait(RUN_ID);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://agents.aetherfy.com/api/v1/deployments/${RUN_ID}` +
        '/wait?timeout_seconds=30'
    );
  });

  it('sends the timeout it was given', async () => {
    await wait(RUN_ID, 45);
    expect(fetchMock.mock.calls[0][0]).toContain('?timeout_seconds=45');
  });

  it('lets the socket outlive the hold the server promised', async () => {
    // THE CLIENT'S BOUND MUST EXCEED THE SERVER'S. A wait the control plane is
    // about to answer at its own deadline must not be cut off here first and
    // reported as a transport failure — the one outcome a caller cannot tell
    // from a real network fault.
    await wait(RUN_ID, 60);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Number));
    expect(timeoutSpy.mock.calls[0][0]).toBeGreaterThan(60_000);
  });

  it('gives a plain read the ordinary timeout', async () => {
    await result(RUN_ID);
    expect(timeoutSpy.mock.calls[0][0]).toBe(30_000);
  });
});

describe('retrying', () => {
  it('does not retry a wait whose connection dropped', async () => {
    // A retry would hold a SECOND full timeout and hand back a run up to twice
    // as late as the number the caller passed.
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    await expect(wait(RUN_ID, 5)).rejects.toBeInstanceOf(AgentTransportError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a plain read once, which is the contrast that makes it a choice', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(reply(200, FINISHED));

    await expect(result(RUN_ID)).resolves.toMatchObject({ state: 'completed' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('the run', () => {
  it('carries its answer', async () => {
    const run = await result(RUN_ID);

    expect(run.id).toBe(RUN_ID);
    expect(run.agent_id).toBe('6f1c2b7e-0a2d-4f8e-9c31-2b0d5a7e4411');
    expect(run.state).toBe('completed');
    expect(run.result).toEqual({ rows: 128 });
    expect(run.result_error).toBeNull();
    expect(run.has_result).toBe(true);
    expect(run.is_ephemeral).toBe(true);
    expect(run.error_message).toBeNull();
  });

  it('keeps the whole object in raw, including what is not named', async () => {
    const run = await result(RUN_ID);
    expect(run.raw).toEqual(FINISHED);
    expect(run.raw.version).toBe(7);
    expect(run.raw.regions).toEqual(['iad']);
  });

  it('reports a refused result as not a result', async () => {
    // image_generator.py's _collect_result classifies an oversized or
    // unparsable file, and Deployment.has_result is False whenever
    // result_error is set: "a refused result is not a result".
    fetchMock.mockResolvedValue(
      reply(200, {
        ...FINISHED,
        result: null,
        result_error: 'too_large',
        has_result: false,
      })
    );
    const run = await result(RUN_ID);

    expect(run.result).toBeNull();
    expect(run.result_error).toBe('too_large');
    expect(run.has_result).toBe(false);
  });

  it('tells a run that returned nothing from one that failed to', async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        ...FINISHED,
        result: null,
        result_error: null,
        has_result: false,
      })
    );
    const run = await result(RUN_ID);

    expect(run.state).toBe('completed');
    expect(run.result).toBeNull();
    expect(run.result_error).toBeNull();
  });

  it('returns the run it has when the wait times out', async () => {
    // A TIMEOUT IS NOT AN ERROR: the route answers 200 with the run exactly as
    // it stands, and `active` on a run means it is executing right now.
    fetchMock.mockResolvedValue(
      reply(200, {
        ...FINISHED,
        state: 'active',
        result: null,
        has_result: false,
      })
    );
    const run = await wait(RUN_ID, 1);

    expect(run.state).toBe('active');
    expect(run.result).toBeNull();
  });

  it('refuses a 200 whose body is not an object', async () => {
    fetchMock.mockResolvedValue(reply(200, 'OK'));
    await expect(result(RUN_ID)).rejects.toBeInstanceOf(RunReadError);
  });
});

describe('the refusals', () => {
  const bothReads: [string, (id: string) => Promise<unknown>][] = [
    ['result', id => result(id)],
    ['wait', id => wait(id)],
  ];

  it.each(bothReads)(
    '%s: an unknown id is RunNotFound',
    async (_name, call) => {
      fetchMock.mockResolvedValue(
        reply(404, refusal('DEPLOYMENT_NOT_FOUND', 'Deployment x not found'))
      );

      const error = await caught<RunNotFound>(call(RUN_ID));
      expect(error).toBeInstanceOf(RunNotFound);
      expect(error.status).toBe(404);
      expect(error.code).toBe('DEPLOYMENT_NOT_FOUND');
      expect(error.message).toContain('not found');
    }
  );

  it.each(bothReads)(
    "%s: someone else's run is RunAccessDenied",
    async (_name, call) => {
      // The control plane loads both routes through _load_customer_deployment
      // for exactly this reason: a caller must not have to know which one it
      // called to handle the error.
      fetchMock.mockResolvedValue(
        reply(403, refusal('DEPLOYMENT_ACCESS_DENIED', 'Access denied'))
      );

      const error = await caught<RunAccessDenied>(call(RUN_ID));
      expect(error).toBeInstanceOf(RunAccessDenied);
      expect(error.status).toBe(403);
      expect(error.code).toBe('DEPLOYMENT_ACCESS_DENIED');
    }
  );

  it('keeps the two provably distinct', async () => {
    fetchMock.mockResolvedValue(reply(404, refusal('DEPLOYMENT_NOT_FOUND')));
    await expect(result(RUN_ID)).rejects.toBeInstanceOf(RunNotFound);

    fetchMock.mockResolvedValue(
      reply(403, refusal('DEPLOYMENT_ACCESS_DENIED'))
    );
    const error = await caught<RunReadError>(result(RUN_ID));
    expect(error).toBeInstanceOf(RunReadError);
    expect(error).not.toBeInstanceOf(RunNotFound);
  });

  it.each([
    [404, 'AGENT_NOT_FOUND'],
    [404, null],
    [403, 'SUBSCRIPTION_SUSPENDED'],
    [422, 'VALIDATION_ERROR'],
  ])(
    'lets the code decide, not the status alone (%i %s)',
    async (status, code) => {
      // A status is a category the control plane reuses across every route; the
      // code is the thing it promises not to rename. A 404 the platform grows
      // for some other reason must not arrive wearing DEPLOYMENT_NOT_FOUND —
      // the caller would branch on a code nothing sent.
      fetchMock.mockResolvedValue(reply(status, refusal(code)));

      const error = await caught<RunReadError>(result(RUN_ID));
      expect(error.constructor).toBe(RunReadError);
      expect(error.status).toBe(status);
      expect(error.code).toBe(code ?? undefined);
    }
  );

  it.each([401, 429, 500, 502, 503])(
    'reports what arrived on %i',
    async status => {
      fetchMock.mockResolvedValue(
        reply(status, refusal('SOMETHING_ELSE', 'upstream said no'))
      );

      const error = await caught<RunReadError>(result(RUN_ID));
      expect(error.status).toBe(status);
      expect(error.code).toBe('SOMETHING_ELSE');
      expect(error.message).toContain('upstream said no');
    }
  );

  it('reads a bare-string detail', async () => {
    // FastAPI's own default for a route that never reached our error handling:
    // prose, no code.
    fetchMock.mockResolvedValue(
      reply(500, { detail: 'Internal Server Error' })
    );

    const error = await caught<RunReadError>(result(RUN_ID));
    expect(error.code).toBeUndefined();
    expect(error.message).toContain('Internal Server Error');
  });

  it('still names the status on a body-free refusal', async () => {
    fetchMock.mockResolvedValue(reply(502, null));

    const error = await caught<RunReadError>(result(RUN_ID));
    expect(error.status).toBe(502);
    expect(error.message).toContain('502');
  });
});

describe('the wait bound', () => {
  it.each([0, -1, 61, 3600])(
    'never leaves the process with timeoutSeconds %i',
    async timeout => {
      const error = await caught<AgentError>(wait(RUN_ID, timeout));
      expect(error).toBeInstanceOf(AgentError);
      expect(error).not.toBeInstanceOf(RunReadError);
      expect(error.message).toContain('between 1 and 60');
      // POSITIVE CONTROL on the claim: no request was sent, so the check really
      // is client-side and not the server's 422 arriving in a different coat.
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([1, 60])('is inclusive at %i', async timeout => {
    await wait(RUN_ID, timeout);
    expect(fetchMock.mock.calls[0][0]).toContain(`?timeout_seconds=${timeout}`);
  });

  it("lets the server's own 422 arrive as a type", async () => {
    // The client-side check has a copy of the server's bound, and a copy can go
    // stale. When it does, the refusal is something to read rather than a bare
    // 422 the helper had no shape for.
    fetchMock.mockResolvedValue(
      reply(
        422,
        refusal(
          'DEPLOYMENT_WAIT_TIMEOUT_INVALID',
          'timeout_seconds must be between 1 and 30; got 45.',
          { field: 'timeout_seconds', min_seconds: 1, max_seconds: 30 }
        )
      )
    );

    const error = await caught<WaitTimeoutInvalid>(wait(RUN_ID, 45));
    expect(error).toBeInstanceOf(WaitTimeoutInvalid);
    expect(error.status).toBe(422);
    expect(error.code).toBe('DEPLOYMENT_WAIT_TIMEOUT_INVALID');
    expect(error.detail.max_seconds).toBe(30);
  });
});

describe('off a machine', () => {
  it.each(['AETHERFY_API_URL', 'AETHERFY_API_KEY'])(
    'names the missing %s',
    async variable => {
      delete process.env[variable];

      for (const call of [() => result(RUN_ID), () => wait(RUN_ID)]) {
        const error = await caught<NotRunningOnAgent>(call());
        expect(error).toBeInstanceOf(NotRunningOnAgent);
        expect(error.variable).toBe(variable);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('refuses an empty run id before a request', async () => {
    // Without this the URL ends in a bare `/deployments/`, which is the LIST
    // route — a 200 carrying an array, and reading `id` off a list gives the
    // string "undefined". A wrong answer, not an error.
    await expect(result('')).rejects.toBeInstanceOf(AgentError);
    await expect(wait('')).rejects.toBeInstanceOf(AgentError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the public surface', () => {
  it('publishes the wait bound, as the Python helper does', () => {
    // ONE API IN TWO LANGUAGES. A task ported between them must not find the
    // bound readable in one and missing from the other's declared surface.
    expect(WAIT_TIMEOUT_MIN_SECONDS).toBe(1);
    expect(WAIT_TIMEOUT_MAX_SECONDS).toBe(60);
    expect(WAIT_TIMEOUT_DEFAULT_SECONDS).toBe(30);
  });

  it('applies the default it publishes', async () => {
    // Two numbers that could disagree: the constant a caller reads and the
    // default wait() actually sends.
    await wait(RUN_ID);
    expect(fetchMock.mock.calls[0][0]).toContain(
      `?timeout_seconds=${WAIT_TIMEOUT_DEFAULT_SECONDS}`
    );
  });
});

describe('the run id in the path', () => {
  it('cannot walk out of its route', async () => {
    // UNESCAPED, `../agents/x` normalises to a DIFFERENT route before the
    // request leaves, and its answer is parsed as though it were a run: `id`
    // becomes the agent's, `state` becomes the string "undefined". A wrong
    // object read as the right one, silently. Encoded, the platform 404s.
    await result('../agents/other');

    const url = fetchMock.mock.calls[0][0];
    expect(url).toBe(
      'https://agents.aetherfy.com/api/v1/deployments/..%2Fagents%2Fother'
    );
    expect(url).not.toContain('/agents/');
  });

  it('is encoded on the wait route too', async () => {
    await wait('../agents/other', 5);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://agents.aetherfy.com/api/v1/deployments/..%2Fagents%2Fother' +
        '/wait?timeout_seconds=5'
    );
  });
});
