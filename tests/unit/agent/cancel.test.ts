/**
 * `cancel()`: the request the control plane's cancel route accepts, the three
 * things it answers 200 with, and every refusal it can send.
 *
 * Pinned against the run queue's contract (`POST /deployments/{run_id}/cancel`):
 * 200 `RunCancelResponse {run, outcome, message, cancelled_count}`, and the
 * refusals 404 `DEPLOYMENT_NOT_FOUND`, 403 `DEPLOYMENT_ACCESS_DENIED`, 403
 * `AUTH_AGENT_KEY_OUT_OF_SCOPE` and 409 `DEPLOYMENT_NOT_A_RUN`. A run that had
 * already ended is an answer, not a refusal.
 *
 * No network is touched — `fetch` is replaced.
 */

import { cancel, result } from '../../../src/agent';
import {
  AgentError,
  NotARun,
  NotRunningOnAgent,
  RunAccessDenied,
  RunCancelError,
  RunNotFound,
  RunReadError,
} from '../../../src/agent/errors';

const RUN_ID = '55555555-5555-5555-5555-555555555555';

// The deployment object a cancel answers with, as DeploymentResponse serializes
// a run: kept whole in `raw`.
const CANCELLED_RUN = {
  id: RUN_ID,
  agent_id: '6f1c2b7e-0a2d-4f8e-9c31-2b0d5a7e4411',
  state: 'cancelled',
  is_ephemeral: true,
  result: null,
  result_error: null,
  has_result: false,
  error_message: null,
  cancellation_reason: 'user_cancel',
  version: 7,
};

function answer(
  outcome: string,
  count = 1,
  state = 'cancelled',
  message = 'done'
) {
  return {
    run: { ...CANCELLED_RUN, state },
    outcome,
    message,
    cancelled_count: count,
  };
}

const realFetch = global.fetch;
let fetchMock: jest.Mock;

function reply(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function refusal(code: string | null, message = 'nope') {
  return { detail: { ...(code ? { code } : {}), message } };
}

/** The error a call rejected with, typed for assertion. */
async function caught<T>(promise: Promise<unknown>): Promise<T> {
  return (await promise.catch(e => e)) as T;
}

beforeEach(() => {
  process.env.AETHERFY_API_URL = 'https://agents.aetherfy.com/api/v1';
  process.env.AETHERFY_API_KEY = 'afy_test_key';

  fetchMock = jest.fn().mockResolvedValue(reply(200, answer('cancelled')));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.AETHERFY_API_URL;
  delete process.env.AETHERFY_API_KEY;
});

describe('the request', () => {
  it("posts to the run's cancel route", async () => {
    await cancel(RUN_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(url).toBe(
      `https://agents.aetherfy.com/api/v1/deployments/${RUN_ID}/cancel`
    );
    // Nothing to say but which run: the id is in the path.
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer afy_test_key');
    expect(init.headers['User-Agent']).toMatch(/^aetherfy-agent-js\//);
  });

  it('is sent again when its answer was lost: a second cancel changes nothing', async () => {
    // REPEATABLE: a cancel that reached the control plane and lost its answer
    // is repeated, and the repeat answers `stopping` with a count of 0.
    fetchMock
      .mockReset()
      .mockRejectedValueOnce(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('socket hang up'), {
            code: 'ECONNRESET',
          }),
        })
      )
      .mockResolvedValueOnce(reply(200, answer('stopping', 0, 'active')));

    const cancellation = await cancel(RUN_ID);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancellation.outcome).toBe('stopping');
    expect(cancellation.cancelled_count).toBe(0);
  });

  it('does not double a trailing slash on the base URL', async () => {
    process.env.AETHERFY_API_URL = 'https://agents.aetherfy.com/api/v1/';
    await cancel(RUN_ID);
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/deployments/');
  });

  it('cannot walk out of its route with a crafted id', async () => {
    // UNESCAPED, `../agents/x` normalises to a DIFFERENT route before the
    // request leaves, and a POST there is a different action. Encoded, the
    // platform answers 404.
    await cancel('../agents/other');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://agents.aetherfy.com/api/v1/deployments/..%2Fagents%2Fother/cancel'
    );
  });

  it('refuses an empty id before a request', async () => {
    await expect(cancel('')).rejects.toBeInstanceOf(AgentError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['AETHERFY_API_URL', 'AETHERFY_API_KEY'])(
    'names %s when it is missing',
    async variable => {
      delete process.env[variable];

      const error = await caught<NotRunningOnAgent>(cancel(RUN_ID));

      expect(error).toBeInstanceOf(NotRunningOnAgent);
      expect(error.variable).toBe(variable);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe('the three answers', () => {
  it.each([
    // Waiting or not yet started: it is cancelled now.
    ['cancelled', 1, 'cancelled'],
    // Executing: being stopped, and it ends cancelled.
    ['stopping', 1, 'active'],
    // Ended before the call: nothing was cancelled.
    ['already_finished', 0, 'completed'],
  ])('turns outcome %s into a Cancellation', async (outcome, count, state) => {
    fetchMock.mockResolvedValue(
      reply(200, answer(outcome, count, state, 'what happened'))
    );

    const cancellation = await cancel(RUN_ID);

    expect(cancellation.outcome).toBe(outcome);
    expect(cancellation.cancelled_count).toBe(count);
    expect(cancellation.message).toBe('what happened');
    expect(cancellation.run.id).toBe(RUN_ID);
    expect(cancellation.run.state).toBe(state);
  });

  it('does not treat a run that had already ended as an error', async () => {
    // Cancelling twice, or racing the run's own end, is an answer. The caller
    // reads `outcome`; nothing is thrown.
    fetchMock.mockResolvedValue(
      reply(200, answer('already_finished', 0, 'completed'))
    );

    await expect(cancel(RUN_ID)).resolves.toMatchObject({
      outcome: 'already_finished',
    });
  });

  it('counts the runs the cascade cancelled', async () => {
    fetchMock.mockResolvedValue(reply(200, answer('cancelled', 4)));

    expect((await cancel(RUN_ID)).cancelled_count).toBe(4);
  });

  it('keeps the whole object in the run', async () => {
    const { run } = await cancel(RUN_ID);

    expect(run.raw.cancellation_reason).toBe('user_cancel');
    expect(run.raw.version).toBe(7);
    expect(run.is_ephemeral).toBe(true);
  });

  it('reads the run a cancel answers with like any other run', async () => {
    // One reader for every run the SDK returns: a cancel's carries the retry it
    // was sent with, and none when it was sent without.
    const body = answer('cancelled');
    fetchMock.mockResolvedValueOnce(
      reply(200, {
        ...body,
        run: {
          ...body.run,
          retry: {
            code: 'PLATFORM_TEMPORARILY_UNAVAILABLE',
            attempt: 3,
            max_attempts: 4,
            next_attempt_at: '2026-11-18T03:12:45Z',
          },
        },
      })
    );

    expect((await cancel(RUN_ID)).run.retry).toEqual({
      code: 'PLATFORM_TEMPORARILY_UNAVAILABLE',
      attempt: 3,
      max_attempts: 4,
      next_attempt_at: new Date(Date.UTC(2026, 10, 18, 3, 12, 45)),
    });

    fetchMock.mockResolvedValueOnce(reply(200, body));
    expect((await cancel(RUN_ID)).run.retry).toBeNull();
  });

  it.each([
    ['a string', 'OK'],
    ['an empty object', {}],
    ['no run', { outcome: 'cancelled' }],
    ['no outcome', { run: CANCELLED_RUN }],
    ['an empty outcome', { run: CANCELLED_RUN, outcome: '' }],
  ])('does not take a 200 with %s for a cancellation', async (_name, body) => {
    fetchMock.mockResolvedValue(reply(200, body));

    const error = await caught<RunCancelError>(cancel(RUN_ID));

    expect(error).toBeInstanceOf(RunCancelError);
    expect(error.status).toBe(200);
  });
});

describe('the refusals', () => {
  it('maps an unknown id to RunNotFound', async () => {
    fetchMock.mockResolvedValue(
      reply(404, refusal('DEPLOYMENT_NOT_FOUND', 'Deployment x not found'))
    );

    const error = await caught<RunNotFound>(cancel(RUN_ID));

    expect(error).toBeInstanceOf(RunNotFound);
    expect(error.status).toBe(404);
    expect(error.code).toBe('DEPLOYMENT_NOT_FOUND');
    expect(error.message).toContain('not found');
  });

  it("maps someone else's run to RunAccessDenied", async () => {
    fetchMock.mockResolvedValue(
      reply(403, refusal('DEPLOYMENT_ACCESS_DENIED', 'Access denied'))
    );

    const error = await caught<RunAccessDenied>(cancel(RUN_ID));

    expect(error).toBeInstanceOf(RunAccessDenied);
    expect(error.status).toBe(403);
    expect(error.code).toBe('DEPLOYMENT_ACCESS_DENIED');
  });

  it("maps a run outside the key's reach to RunAccessDenied, with its own code", async () => {
    // An agent's key may cancel only the runs below its own run. The refusal is
    // a RunAccessDenied, and it carries the code the platform SENT: it must not
    // report DEPLOYMENT_ACCESS_DENIED, a different problem (whose run it is).
    fetchMock.mockResolvedValue(
      reply(
        403,
        refusal(
          'AUTH_AGENT_KEY_OUT_OF_SCOPE',
          "This agent's key may cancel only the runs below its own run."
        )
      )
    );

    const error = await caught<RunAccessDenied>(cancel(RUN_ID));

    expect(error).toBeInstanceOf(RunAccessDenied);
    expect(error.status).toBe(403);
    expect(error.code).toBe('AUTH_AGENT_KEY_OUT_OF_SCOPE');
    expect(error.message).toContain('below its own run');
    expect(error.detail.code).toBe('AUTH_AGENT_KEY_OUT_OF_SCOPE');
  });

  it('leaves the same 403 on a read a plain RunReadError', async () => {
    // The cancel maps the out-of-scope 403 onto RunAccessDenied; a READ does
    // not, and must not start to: what the key may read is not whose run it is.
    fetchMock.mockResolvedValue(
      reply(403, refusal('AUTH_AGENT_KEY_OUT_OF_SCOPE', 'no'))
    );

    const error = await caught<RunReadError>(result(RUN_ID));

    expect(error).toBeInstanceOf(RunReadError);
    expect(error).not.toBeInstanceOf(RunAccessDenied);
    expect(error.code).toBe('AUTH_AGENT_KEY_OUT_OF_SCOPE');
  });

  it('maps a release id to NotARun', async () => {
    fetchMock.mockResolvedValue(
      reply(
        409,
        refusal(
          'DEPLOYMENT_NOT_A_RUN',
          'That is a release. Cancel it with `afy cancel <agent>`.'
        )
      )
    );

    const error = await caught<NotARun>(cancel(RUN_ID));

    expect(error).toBeInstanceOf(NotARun);
    expect(error).toBeInstanceOf(RunCancelError);
    expect(error.status).toBe(409);
    expect(error.code).toBe('DEPLOYMENT_NOT_A_RUN');
    expect(error.message).toContain('afy cancel');
  });

  it.each([
    [404, 'AGENT_NOT_FOUND'],
    [404, null],
    [403, 'SUBSCRIPTION_SUSPENDED'],
    [403, null],
    [409, 'DEPLOYMENT_TERMINAL_CANNOT_CANCEL'],
    [409, null],
  ])(
    'lets the code decide, not the status alone (%i %s)',
    async (status, code) => {
      // A status is a category the control plane reuses across every route;
      // the code is the thing it promises not to rename. A 409 grown for some
      // other reason must not arrive wearing DEPLOYMENT_NOT_A_RUN.
      fetchMock.mockResolvedValue(
        reply(status, code ? refusal(code) : { detail: {} })
      );

      const error = await caught<RunCancelError>(cancel(RUN_ID));

      expect(error.constructor).toBe(RunCancelError);
      expect(error.status).toBe(status);
      expect(error.code).toBe(code ?? undefined);
    }
  );

  it.each([401, 429, 500, 502, 503])(
    'reports what arrived on a %i',
    async status => {
      fetchMock.mockResolvedValue(
        reply(status, refusal('SOMETHING_ELSE', 'upstream said no'))
      );

      const error = await caught<RunCancelError>(cancel(RUN_ID));

      expect(error.constructor).toBe(RunCancelError);
      expect(error.status).toBe(status);
      expect(error.code).toBe('SOMETHING_ELSE');
      expect(error.message).toContain('upstream said no');
    }
  );

  it('carries the time the control plane asked for, and never retries', async () => {
    fetchMock.mockResolvedValue(
      reply(503, { detail: { message: 'busy' } }, { 'Retry-After': '9' })
    );

    const error = await caught<RunCancelError>(cancel(RUN_ID));

    expect(error.retryAfter).toBe(9);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('survives a bare string detail', async () => {
    fetchMock.mockResolvedValue(
      reply(500, { detail: 'Internal Server Error' })
    );

    const error = await caught<RunCancelError>(cancel(RUN_ID));

    expect(error.code).toBeUndefined();
    expect(error.message).toContain('Internal Server Error');
  });

  it('names the status of a body-free refusal', async () => {
    fetchMock.mockResolvedValue(reply(502, null));

    const error = await caught<RunCancelError>(cancel(RUN_ID));

    expect(error.status).toBe(502);
    expect(error.message).toContain('502');
  });

  it('keeps the two shared refusals out of the cancel family', () => {
    // A caller that catches only RunCancelError misses the 404 and the 403, and
    // the docs say so. AgentError sees all of them.
    expect(new RunNotFound('x')).not.toBeInstanceOf(RunCancelError);
    expect(new RunAccessDenied('x')).not.toBeInstanceOf(RunCancelError);
    expect(new NotARun('x')).toBeInstanceOf(RunCancelError);
    for (const error of [
      new RunNotFound('x'),
      new RunAccessDenied('x'),
      new RunCancelError('x'),
      new NotARun('x'),
    ]) {
      expect(error).toBeInstanceOf(AgentError);
    }
  });
});
