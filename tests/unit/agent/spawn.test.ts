/**
 * `spawn()`: the request the control plane's route actually accepts, what an
 * accepted run looks like (queued, or waiting in the account's line), and the
 * two refusals a caller has to tell apart.
 *
 * Pinned against aetherfy-control-plane `api/routes/agents.py`:
 * `SpawnRequest` (child_agent_id + payload), the route
 * `POST /agents/{agent_id_or_name}/spawn` returning 202 with `SpawnResponse`,
 * and the `{"detail": {...}}` error envelope built by `shared/api_errors.py`.
 */

import { spawn } from '../../../src/agent';
import {
  AgentTransportError,
  NotRunningOnAgent,
  PayloadTooLarge,
  RunLineFull,
  SpawnError,
} from '../../../src/agent/errors';

const ACCEPTED = {
  spawn_id: '11111111-1111-1111-1111-111111111111',
  job_id: '22222222-2222-2222-2222-222222222222',
  child_agent_id: '33333333-3333-3333-3333-333333333333',
  workspace: 'research',
  region: 'us-east-1',
  status: 'queued',
  estimated_start: '~1s',
};

const realFetch = global.fetch;
let fetchMock: jest.Mock;

function reply(status: number, body: unknown): Response {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  // Exactly what orchestrator/fly_manager.py injects, including the literal
  // `{id}` placeholder in the spawn URL.
  process.env.AETHERFY_SPAWN_URL =
    'https://agents.aetherfy.com/api/v1/agents/{id}/spawn';
  process.env.AETHERFY_AGENT_ID = 'parent-agent-id';
  process.env.AETHERFY_API_KEY = 'afy_test_key';

  fetchMock = jest.fn().mockResolvedValue(reply(202, ACCEPTED));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.AETHERFY_SPAWN_URL;
  delete process.env.AETHERFY_AGENT_ID;
  delete process.env.AETHERFY_API_KEY;
});

describe('spawn()', () => {
  it('sends the request the route accepts', async () => {
    await spawn('nightly-rollup', { date: '2026-09-07' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    // THE VARIABLE IS A TEMPLATE. Posting it verbatim would send a request to
    // a path holding a literal brace.
    expect(url).toBe(
      'https://agents.aetherfy.com/api/v1/agents/parent-agent-id/spawn'
    );
    expect(url).not.toContain('{id}');
    expect(JSON.parse(init.body)).toEqual({
      child_agent_id: 'nightly-rollup',
      payload: { date: '2026-09-07' },
    });
    expect(init.headers.Authorization).toBe('Bearer afy_test_key');
    expect(init.headers['User-Agent']).toMatch(/^aetherfy-agent-js\//);
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('sends an empty object when no payload is given', async () => {
    await spawn('nightly-rollup');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).payload).toEqual({});
  });

  it('leaves an already-resolved URL alone', async () => {
    // A platform that stops templating the variable keeps working.
    process.env.AETHERFY_SPAWN_URL =
      'https://agents.aetherfy.com/api/v1/agents/abc/spawn';
    delete process.env.AETHERFY_AGENT_ID;

    await spawn('nightly-rollup');

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/agents\/abc\/spawn$/);
  });

  it('turns the accepted response into a Spawn', async () => {
    await expect(spawn('nightly-rollup')).resolves.toEqual({
      spawn_id: ACCEPTED.spawn_id,
      job_id: ACCEPTED.job_id,
      child_agent_id: ACCEPTED.child_agent_id,
      region: 'us-east-1',
      status: 'queued',
      workspace: 'research',
      estimated_start: '~1s',
      // A run that goes straight to a machine has no place in the line.
      position: null,
      raw: ACCEPTED,
    });
  });

  it('gives a run waiting in the line no job and a place', async () => {
    // The account is at its limit: the run is accepted and waits. It has no job
    // yet, so `job_id` is null (not the string "null"), and `position` is its
    // place in the line, 1 being next.
    fetchMock.mockResolvedValue(
      reply(202, { ...ACCEPTED, job_id: null, status: 'waiting', position: 3 })
    );

    const run = await spawn('nightly-rollup');

    expect(run.status).toBe('waiting');
    expect(run.job_id).toBeNull();
    expect(run.position).toBe(3);
    expect(run.spawn_id).toBe(ACCEPTED.spawn_id);
  });

  it.each([['3'], [2.5], [true], [[1]], [{ n: 1 }]])(
    'takes a position that is not an integer (%p) for no position',
    async position => {
      fetchMock.mockResolvedValue(
        reply(202, { ...ACCEPTED, status: 'waiting', position })
      );

      expect((await spawn('nightly-rollup')).position).toBeNull();
    }
  );

  it('keeps the whole response body in raw', async () => {
    // What the platform sends beyond the named fields is kept, as `Run.raw`
    // keeps the whole deployment object.
    const body = {
      ...ACCEPTED,
      status: 'waiting',
      position: 1,
      job_id: null,
      extra: 'x',
    };
    fetchMock.mockResolvedValue(reply(202, body));

    expect((await spawn('nightly-rollup')).raw).toEqual(body);
  });

  it("carries the spawned agent's workspace name, which is never null", async () => {
    fetchMock.mockResolvedValue(reply(202, ACCEPTED));

    // Typed `string`: this assignment does not compile against
    // `string | null` (ts-jest type-checks this file).
    const workspace: string = (await spawn('nightly-rollup')).workspace;
    expect(workspace).toBe('research');
  });

  it('maps 413 to PayloadTooLarge', async () => {
    fetchMock.mockResolvedValue(
      reply(413, {
        detail: {
          code: 'RUN_PAYLOAD_TOO_LARGE',
          message:
            'The run payload is 300000 bytes; the inline cap is 262144 bytes.',
          payload_bytes: 300000,
          max_bytes: 262144,
        },
      })
    );

    const error = await spawn('nightly-rollup', { blob: '...' }).catch(e => e);
    expect(error).toBeInstanceOf(PayloadTooLarge);
    expect(error.payloadBytes).toBe(300000);
    expect(error.maxBytes).toBe(262144);
    expect(error.code).toBe('RUN_PAYLOAD_TOO_LARGE');
    expect(error.status).toBe(413);
  });

  it('maps 429 to RunLineFull', async () => {
    // The envelope of the 429 a spawn gets when the account's line already
    // holds the most waiting runs its plan allows: `limit` names WHICH plan
    // limit was hit, and the counts say where the account stands. The limits
    // are the ACCOUNT's, set by the plan, not a per-agent spawn ceiling.
    fetchMock.mockResolvedValue(
      reply(429, {
        detail: {
          code: 'AGENT_RUN_LINE_FULL',
          message:
            'The line of waiting runs is full (50/50); wait for some to start. The limit is set by your plan.',
          limit: 'max_waiting_runs',
          waiting_count: 50,
          max_waiting_runs: 50,
          in_flight_count: 25,
          max_in_flight_runs: 25,
        },
      })
    );

    const error = await spawn('nightly-rollup').catch(e => e);
    expect(error).toBeInstanceOf(RunLineFull);
    expect(error).toBeInstanceOf(SpawnError);
    expect(error.waitingCount).toBe(50);
    expect(error.maxWaitingRuns).toBe(50);
    expect(error.inFlightCount).toBe(25);
    expect(error.maxInFlightRuns).toBe(25);
    expect(error.limit).toBe('max_waiting_runs');
    expect(error.code).toBe('AGENT_RUN_LINE_FULL');
    expect(error.status).toBe(429);
  });

  it('survives an uncapped number on 429', async () => {
    // A count the envelope leaves null stays null. A caller building a message
    // from it must not be handed undefined instead.
    fetchMock.mockResolvedValue(
      reply(429, {
        detail: {
          code: 'AGENT_RUN_LINE_FULL',
          message: 'The line is full.',
          limit: 'max_waiting_runs',
          waiting_count: 400,
          max_waiting_runs: 400,
          in_flight_count: 3,
          max_in_flight_runs: null,
        },
      })
    );

    const error = await spawn('nightly-rollup').catch(e => e);
    expect(error.maxInFlightRuns).toBeNull();
    expect(error.inFlightCount).toBe(3);
  });

  it('reads the limit name rather than assuming it', async () => {
    // `limit` is read off the envelope, not hardcoded. A second named limit
    // reaching this code must arrive intact, not be reported as the first.
    fetchMock.mockResolvedValue(
      reply(429, {
        detail: {
          code: 'AGENT_RUN_LINE_FULL',
          message: 'Some other cap.',
          limit: 'max_agents',
          waiting_count: 3,
        },
      })
    );

    const error = await spawn('nightly-rollup').catch(e => e);
    expect(error.limit).toBe('max_agents');
  });

  it('treats a 413 carrying another code as a plain SpawnError', async () => {
    // THE PAIRING SELECTS THE TYPE. A status is a category the platform reuses;
    // the code is what it promises not to rename. A 413 grown for some new
    // reason must arrive reporting ITS code, not wearing RUN_PAYLOAD_TOO_LARGE's.
    fetchMock.mockResolvedValue(
      reply(413, {
        detail: {
          code: 'AGENT_IMAGE_TOO_LARGE',
          message: 'The built image is larger than the runtime allows.',
        },
      })
    );

    const error = await spawn('nightly-rollup').catch(e => e);
    expect(error).toBeInstanceOf(SpawnError);
    expect(error).not.toBeInstanceOf(PayloadTooLarge);
    expect(error.code).toBe('AGENT_IMAGE_TOO_LARGE');
    expect(error.status).toBe(413);
    expect(error.message).toContain('larger than the runtime allows');
  });

  it('treats a 429 carrying another code as a plain SpawnError', async () => {
    fetchMock.mockResolvedValue(
      reply(429, {
        detail: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' },
      })
    );

    const error = await spawn('nightly-rollup').catch(e => e);
    expect(error).toBeInstanceOf(SpawnError);
    expect(error).not.toBeInstanceOf(RunLineFull);
    expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(error.status).toBe(429);
  });

  it.each([413, 429])(
    'treats a codeless %i body as a plain SpawnError',
    async status => {
      // No code is not the expected code. Reporting one of the typed errors
      // here would attach a code the platform never sent.
      fetchMock.mockResolvedValue(
        reply(status, { detail: { message: 'no code here' } })
      );

      const error = await spawn('nightly-rollup').catch(e => e);
      expect(error).toBeInstanceOf(SpawnError);
      expect(error).not.toBeInstanceOf(PayloadTooLarge);
      expect(error).not.toBeInstanceOf(RunLineFull);
      expect(error.code).toBeUndefined();
      expect(error.status).toBe(status);
    }
  );

  it('maps a 429 carrying no extras', async () => {
    fetchMock.mockResolvedValue(
      reply(429, {
        detail: { code: 'AGENT_RUN_LINE_FULL', message: 'busy' },
      })
    );

    const error = await spawn('nightly-rollup').catch(e => e);
    expect(error).toBeInstanceOf(RunLineFull);
    // null, not undefined — the Python helper reports None for the same body,
    // and a task ported between the two should not have to know the difference.
    expect(error.limit).toBeNull();
    expect(error.waitingCount).toBeNull();
    expect(error.maxWaitingRuns).toBeNull();
    expect(error.inFlightCount).toBeNull();
    expect(error.maxInFlightRuns).toBeNull();
  });

  it('keeps the two refusals distinguishable', async () => {
    // They must not collapse into one another: PayloadTooLarge is permanent
    // for this payload, RunLineFull is the one worth trying again later.
    const tooLarge = new PayloadTooLarge('a');
    const lineFull = new RunLineFull('b');

    expect(tooLarge).toBeInstanceOf(SpawnError);
    expect(lineFull).toBeInstanceOf(SpawnError);
    expect(tooLarge).not.toBeInstanceOf(RunLineFull);
    expect(lineFull).not.toBeInstanceOf(PayloadTooLarge);
  });

  it.each([
    [400, 'AGENT_SPAWN_DEPTH_INVALID'],
    [403, 'AGENT_NOT_SPAWN_ENABLED'],
    [403, 'AGENT_WORKER_NOT_ALLOWED'],
    [409, 'AGENT_PARENT_NOT_SPAWNABLE'],
    [409, 'AGENT_WORKER_PAUSED'],
    [503, 'AGENT_SPAWN_RATE_LIMITED'],
    [500, 'INTERNAL_ERROR'],
  ])('carries the platform code on %i %s', async (status, code) => {
    fetchMock.mockResolvedValue(
      reply(status, { detail: { code, message: 'refused' } })
    );

    const error = await spawn('nightly-rollup').catch(e => e);
    expect(error).toBeInstanceOf(SpawnError);
    expect(error).not.toBeInstanceOf(PayloadTooLarge);
    expect(error).not.toBeInstanceOf(RunLineFull);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.message).toContain('refused');
  });

  it('survives a bare string detail', async () => {
    // FastAPI's own default for a route that never reached our error
    // handling — prose, no code.
    fetchMock.mockResolvedValue(reply(404, { detail: 'Not Found' }));

    const error = await spawn('nightly-rollup').catch(e => e);
    expect(error).toBeInstanceOf(SpawnError);
    expect(error.code).toBeUndefined();
    expect(error.message).toContain('Not Found');
  });

  it('still raises on a body-free error', async () => {
    fetchMock.mockResolvedValue(reply(502, null));

    const error = await spawn('nightly-rollup').catch(e => e);
    expect(error).toBeInstanceOf(SpawnError);
    expect(error.status).toBe(502);
  });

  it('never retries an error status', async () => {
    // A repeated 4xx is still a 4xx, and a repeated spawn the control plane
    // may already have recorded is a second run.
    fetchMock.mockResolvedValue(
      reply(409, { detail: { code: 'AGENT_WORKER_PAUSED', message: 'paused' } })
    );

    await expect(spawn('nightly-rollup')).rejects.toThrow(SpawnError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a connection failure exactly once, then reports transport', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(spawn('nightly-rollup')).rejects.toThrow(AgentTransportError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a body that fails mid-read', async () => {
    // The server ANSWERED. On a spawn that means the control plane already
    // recorded the run, so a second attempt would create a second one — the
    // body is lost, the status is not.
    fetchMock.mockResolvedValue({
      status: 202,
      headers: new Headers(),
      text: async () => {
        throw new TypeError('terminated');
      },
    });

    const error = await spawn('nightly-rollup').catch(e => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 202 with an unreadable body: accepted, but the run cannot be identified.
    expect(error).toBeInstanceOf(SpawnError);
    expect(error).not.toBeInstanceOf(AgentTransportError);
  });

  it('succeeds when the retry lands', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(202, ACCEPTED));

    await expect(spawn('nightly-rollup')).resolves.toMatchObject({
      status: 'queued',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['AETHERFY_SPAWN_URL', 'AETHERFY_API_KEY'])(
    'names %s when it is missing',
    async variable => {
      delete process.env[variable];

      await expect(spawn('nightly-rollup')).rejects.toThrow(NotRunningOnAgent);
      await expect(spawn('nightly-rollup')).rejects.toThrow(variable);
    }
  );
});

describe('Retry-After on a refusal', () => {
  const refused = (status: number, headers: Record<string, string>) =>
    new Response(JSON.stringify({ detail: { message: 'busy' } }), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });

  it('a full line is refused once and nothing is retried for you', async () => {
    // The control plane sends no Retry-After with this refusal, so there is no
    // time to carry, and the helper never repeats a spawn itself.
    fetchMock.mockResolvedValue(
      reply(429, { detail: { code: 'AGENT_RUN_LINE_FULL', message: 'full' } })
    );
    const error = await spawn('worker').catch(e => e);
    expect(error).toBeInstanceOf(RunLineFull);
    expect(error.retryAfter).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 503 carries the time too', async () => {
    fetchMock.mockResolvedValue(refused(503, { 'Retry-After': '5' }));
    const error = await spawn('worker').catch(e => e);
    expect(error).toBeInstanceOf(SpawnError);
    expect(error.status).toBe(503);
    expect(error.retryAfter).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'soon', '-3', 'NaN'])(
    'an unreadable header (%p) is no time',
    async value => {
      fetchMock.mockResolvedValue(refused(503, { 'Retry-After': value }));
      const error = await spawn('worker').catch(e => e);
      expect(error.retryAfter).toBeUndefined();
    }
  );

  it('a refusal without the header has no time', async () => {
    fetchMock.mockResolvedValue(refused(503, {}));
    const error = await spawn('worker').catch(e => e);
    expect(error.retryAfter).toBeUndefined();
  });
});
