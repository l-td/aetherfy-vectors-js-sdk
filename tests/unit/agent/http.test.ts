/**
 * `requestJson`, the agent module's transport to the control plane, exercised
 * directly: when it retries, and when it must not.
 *
 * - a request that NEVER LEFT (the name did not resolve, the connection was
 *   refused) is retried once, whatever the call;
 * - a request that MAY HAVE BEEN DELIVERED (a timeout or a reset after it was
 *   sent) is retried once only when the call is repeatable, and otherwise
 *   throws at once saying it may have been applied;
 * - a status is never retried.
 *
 * `fetch` is the only thing stubbed. Nothing here opens a socket.
 */

import { requestJson } from '../../../src/agent/http';
import { AgentTransportError } from '../../../src/agent/errors';

const realFetch = global.fetch;
let fetchMock: jest.Mock;

const URL = 'https://agents.aetherfy.com/api/v1/agents/a/spawn';

function withCause(code: string, message: string): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(message), { code }),
  });
}

/** A request that never left: nothing accepted it. */
const NEVER_DELIVERED: Array<[string, Error]> = [
  ['the name did not resolve', withCause('ENOTFOUND', 'getaddrinfo ENOTFOUND')],
  [
    'the name lookup failed for now',
    withCause('EAI_AGAIN', 'getaddrinfo EAI_AGAIN'),
  ],
  [
    'the connection was refused',
    withCause('ECONNREFUSED', 'connect ECONNREFUSED'),
  ],
];

/** A request that may have been delivered: it can fail after the far side acted. */
const MAYBE_DELIVERED: Array<[string, Error]> = [
  [
    'a timeout',
    Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    }),
  ],
  ['a reset after sending', withCause('ECONNRESET', 'socket hang up')],
  ['a failure with no code', new TypeError('fetch failed')],
];

function accepted(): Response {
  return new Response(JSON.stringify({ status: 'queued' }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
}

function send(repeatable: boolean) {
  return requestJson('POST', URL, {
    apiKey: 'afy_test_key',
    userAgent: 'aetherfy-agent-js/test',
    body: { child_agent_id: 'worker', payload: {}, request_id: 'r-1' },
    repeatable,
  });
}

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
});

describe('requestJson', () => {
  describe.each(NEVER_DELIVERED)(
    'a request that never left: %s',
    (_name, failure) => {
      it.each([true, false])(
        'is retried once (repeatable %s)',
        async repeatable => {
          fetchMock.mockRejectedValue(failure);
          await expect(send(repeatable)).rejects.toThrow(
            /did not reach the Aetherfy control plane after 2 attempt\(s\)/
          );
          expect(fetchMock).toHaveBeenCalledTimes(2);
        }
      );
    }
  );

  describe.each(MAYBE_DELIVERED)(
    'a request that may have been delivered: %s',
    (_name, failure) => {
      it('is retried once when the call is repeatable', async () => {
        fetchMock.mockRejectedValue(failure);
        await expect(send(true)).rejects.toBeInstanceOf(AgentTransportError);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it('is never repeated when the call is not repeatable', async () => {
        fetchMock.mockRejectedValue(failure);
        await expect(send(false)).rejects.toThrow(/may have been applied/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    }
  );

  it('can succeed on its retry', async () => {
    fetchMock
      .mockRejectedValueOnce(withCause('EAI_AGAIN', 'getaddrinfo EAI_AGAIN'))
      .mockResolvedValueOnce(accepted());
    const { status, body } = await send(false);
    expect(status).toBe(202);
    expect(body).toEqual({ status: 'queued' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends the same request again, its body and its id included', async () => {
    // The idempotency of a spawn rests on this: the retry carries the SAME
    // request_id as the first attempt, so the control plane recognises it.
    fetchMock
      .mockRejectedValueOnce(withCause('ECONNRESET', 'socket hang up'))
      .mockResolvedValueOnce(accepted());
    await send(true);
    const bodies = fetchMock.mock.calls.map(([, init]) => init.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it('never retries a status', async () => {
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 503, headers: { 'Retry-After': '5' } })
    );
    const { status, retryAfter } = await send(true);
    expect(status).toBe(503);
    expect(retryAfter).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
