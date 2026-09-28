/**
 * `connection()`: the request the control plane's token route accepts, the
 * four refusals a caller branches on, and the per-name cache. Same contract,
 * same cases, as the Python helper's tests/agent/test_connections.py.
 *
 * Pinned against aetherfy-control-plane `api/routes/connections.py`
 * (`POST /connections/{name}/token`, body `{min_valid_seconds}`) and
 * `shared/connections/broker.py` (the refusal codes and statuses). The
 * network is nock; nothing in src/ is replaced.
 */

import nock from 'nock';

import { connection } from '../../../src/agent';
import { clearConnectionCache } from '../../../src/agent/connections';
import {
  AgentError,
  ConnectionAccessDenied,
  ConnectionNeedsReauth,
  ConnectionNotFound,
  ConnectionTokenError,
  ConnectionUnavailable,
  NotRunningOnAgent,
} from '../../../src/agent/errors';

const HOST = 'https://agents.aetherfy.com';
const PATH = '/api/v1/connections/google/token';

function answer(
  expiresIn: number | null = 3600,
  token = 'ya29.token',
  extra: Record<string, unknown> = {}
) {
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_at:
      expiresIn === null
        ? null
        : new Date(Date.now() + expiresIn * 1000).toISOString(),
    provider: 'google',
    name: 'google',
    account_label: 'you@example.com',
    scopes: ['openid', 'https://www.googleapis.com/auth/drive.file'],
    ...extra,
  };
}

beforeEach(() => {
  process.env.AETHERFY_API_URL = `${HOST}/api/v1`;
  process.env.AETHERFY_API_KEY = 'afy_test_agentkey';
  clearConnectionCache();
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  delete process.env.AETHERFY_API_URL;
  delete process.env.AETHERFY_API_KEY;
});

describe('connection()', () => {
  it('sends the request the route accepts', async () => {
    let seen: { body: unknown; headers: Record<string, unknown> } | undefined;
    nock(HOST)
      .post(PATH)
      .reply(function (_uri, body) {
        seen = { body, headers: this.req.headers };
        return [200, answer()];
      });

    const token = await connection('google', { minValidSeconds: 120 });

    expect(seen?.body).toEqual({ min_valid_seconds: 120 });
    expect(seen?.headers.authorization).toBe('Bearer afy_test_agentkey');
    expect(String(seen?.headers['user-agent'])).toMatch(/^aetherfy-agent-js\//);
    expect(token.access_token).toBe('ya29.token');
    expect(token.token_type).toBe('Bearer');
    expect(token.expires_at).toBeInstanceOf(Date);
    expect(token.scopes).toEqual([
      'openid',
      'https://www.googleapis.com/auth/drive.file',
    ]);
  });

  it('escapes the name into one path segment', async () => {
    const scope = nock(HOST)
      .post('/api/v1/connections/a%2Fb/token')
      .reply(200, answer());
    await connection('a/b');
    expect(scope.isDone()).toBe(true);
  });

  it('reuses a fresh token from the cache', async () => {
    const scope = nock(HOST).post(PATH).once().reply(200, answer());
    const first = await connection('google');
    const second = await connection('google', { minValidSeconds: 600 });
    expect(second).toBe(first);
    expect(scope.isDone()).toBe(true);
  });

  it('fetches again when the cached token is inside the margin', async () => {
    nock(HOST).post(PATH).reply(200, answer(200, 'old'));
    nock(HOST).post(PATH).reply(200, answer(3600, 'new'));
    expect(
      (await connection('google', { minValidSeconds: 60 })).access_token
    ).toBe('old');
    expect(
      (await connection('google', { minValidSeconds: 300 })).access_token
    ).toBe('new');
  });

  it('holds the cache to the one-minute floor too', async () => {
    nock(HOST).post(PATH).reply(200, answer(50, 'old'));
    nock(HOST).post(PATH).reply(200, answer(3600, 'new'));
    await connection('google', { minValidSeconds: 0 });
    expect(
      (await connection('google', { minValidSeconds: 0 })).access_token
    ).toBe('new');
  });

  it('rechecks a never-expiring token after five minutes', async () => {
    // Cached, but not for good: a disconnect on the dashboard revokes it, and
    // a long-running agent must hear about that.
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const scope = nock(HOST)
        .post(PATH)
        .once()
        .reply(200, answer(null, 'first', { provider: 'notion' }));
      const first = await connection('google', { minValidSeconds: 3000 });
      expect(first.expires_at).toBeNull();
      now.mockReturnValue(start + 5 * 60 * 1000 - 1);
      expect(await connection('google', { minValidSeconds: 3000 })).toBe(first);
      expect(scope.isDone()).toBe(true);

      nock(HOST)
        .post(PATH)
        .reply(200, answer(null, 'second', { provider: 'notion' }));
      now.mockReturnValue(start + 5 * 60 * 1000);
      expect(
        (await connection('google', { minValidSeconds: 3000 })).access_token
      ).toBe('second');
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    [404, 'CONNECTION_NOT_FOUND', ConnectionNotFound, false],
    [409, 'CONNECTION_NEEDS_REAUTH', ConnectionNeedsReauth, false],
    [502, 'CONNECTION_PROVIDER_UNAVAILABLE', ConnectionUnavailable, true],
    [403, 'CONNECTION_REQUIRES_AGENT_KEY', ConnectionAccessDenied, false],
  ] as const)(
    'maps %i %s to its class',
    async (status, code, Class, retryable) => {
      nock(HOST)
        .post(PATH)
        .reply(status, { detail: { code, message: 'said the server' } });
      const error = await connection('google').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Class);
      expect(error).toBeInstanceOf(ConnectionTokenError);
      const e = error as ConnectionTokenError;
      expect([e.status, e.code, e.retryable, e.message]).toEqual([
        status,
        code,
        retryable,
        'said the server',
      ]);
    }
  );

  it('reports an unrecognised pairing as it came', async () => {
    nock(HOST)
      .post(PATH)
      .reply(404, { detail: { code: 'AGENT_NOT_FOUND', message: 'gone' } });
    const error = (await connection('google').catch(
      (e: unknown) => e
    )) as ConnectionTokenError;
    expect(error.constructor).toBe(ConnectionTokenError);
    expect(error.code).toBe('AGENT_NOT_FOUND');
  });

  it('drops the cached token on needs_reauth', async () => {
    nock(HOST).post(PATH).reply(200, answer(200, 'old'));
    nock(HOST)
      .post(PATH)
      .reply(409, {
        detail: { code: 'CONNECTION_NEEDS_REAUTH', message: 'reconnect' },
      });
    nock(HOST).post(PATH).reply(200, answer(3600, 'new'));
    await connection('google', { minValidSeconds: 60 });
    await expect(
      connection('google', { minValidSeconds: 300 })
    ).rejects.toBeInstanceOf(ConnectionNeedsReauth);
    // Not served from the cache: the grant it came from is gone.
    expect(
      (await connection('google', { minValidSeconds: 60 })).access_token
    ).toBe('new');
  });

  it.each([-1, 3001, 1.5])(
    'refuses minValidSeconds %p before any request',
    async value => {
      await expect(
        connection('google', { minValidSeconds: value })
      ).rejects.toBeInstanceOf(AgentError);
    }
  );

  it('says so off a machine', async () => {
    delete process.env.AETHERFY_API_KEY;
    await expect(connection('google')).rejects.toBeInstanceOf(
      NotRunningOnAgent
    );
  });
});
