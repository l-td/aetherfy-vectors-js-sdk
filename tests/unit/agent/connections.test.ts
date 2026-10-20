/**
 * `connection()` and `listConnections()`: the requests the control plane's
 * routes accept, the refusals a caller branches on, and the per-id cache. Same contract,
 * same cases, as the Python helper's tests/agent/test_connections.py.
 *
 * Pinned against aetherfy-control-plane `api/routes/connections.py`
 * (`POST /connections/{connection_id}/token`, body `{min_valid_seconds}`;
 * `GET /connections/usable`) and
 * `shared/connections/broker.py` (the refusal codes and statuses). The
 * network is nock; nothing in src/ is replaced.
 */

import nock from 'nock';

import { connection, listConnections } from '../../../src/agent';
import { clearConnectionCache } from '../../../src/agent/connections';
import {
  AgentError,
  ConnectionAccessDenied,
  ConnectionGrantNotEnabled,
  ConnectionNeedsReauth,
  ConnectionNotFound,
  ConnectionTokenError,
  ConnectionUnavailable,
  NotRunningOnAgent,
} from '../../../src/agent/errors';

const HOST = 'https://agents.aetherfy.com';
const GOOGLE = '6f1c2b7e-0a2d-4f8e-9c31-2b0d5a7e4411';
const PATH = `/api/v1/connections/${GOOGLE}/token`;

function answer(
  expiresIn: number | null = 3600,
  token = 'ya29.token',
  extra: Record<string, unknown> = {}
) {
  return {
    id: GOOGLE,
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

    const token = await connection(GOOGLE, { minValidSeconds: 120 });

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

  it('refuses an id that is not a uuid before any request (a name was an address once)', async () => {
    for (const bad of ['google', 'a/b', '', 7 as unknown as string]) {
      await expect(connection(bad)).rejects.toBeInstanceOf(AgentError);
    }
  });

  it('reuses a fresh token from the cache', async () => {
    const scope = nock(HOST).post(PATH).once().reply(200, answer());
    const first = await connection(GOOGLE);
    const second = await connection(GOOGLE, { minValidSeconds: 600 });
    expect(second).toBe(first);
    expect(scope.isDone()).toBe(true);
  });

  it('fetches again when the cached token is inside the margin', async () => {
    nock(HOST).post(PATH).reply(200, answer(200, 'old'));
    nock(HOST).post(PATH).reply(200, answer(3600, 'new'));
    expect(
      (await connection(GOOGLE, { minValidSeconds: 60 })).access_token
    ).toBe('old');
    expect(
      (await connection(GOOGLE, { minValidSeconds: 300 })).access_token
    ).toBe('new');
  });

  it('holds the cache to the one-minute floor too', async () => {
    nock(HOST).post(PATH).reply(200, answer(50, 'old'));
    nock(HOST).post(PATH).reply(200, answer(3600, 'new'));
    await connection(GOOGLE, { minValidSeconds: 0 });
    expect(
      (await connection(GOOGLE, { minValidSeconds: 0 })).access_token
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
      const first = await connection(GOOGLE, { minValidSeconds: 3000 });
      expect(first.expires_at).toBeNull();
      now.mockReturnValue(start + 5 * 60 * 1000 - 1);
      expect(await connection(GOOGLE, { minValidSeconds: 3000 })).toBe(first);
      expect(scope.isDone()).toBe(true);

      nock(HOST)
        .post(PATH)
        .reply(200, answer(null, 'second', { provider: 'notion' }));
      now.mockReturnValue(start + 5 * 60 * 1000);
      expect(
        (await connection(GOOGLE, { minValidSeconds: 3000 })).access_token
      ).toBe('second');
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    [404, 'CONNECTION_NOT_FOUND', ConnectionNotFound, false],
    [403, 'CONNECTION_GRANT_NOT_ENABLED', ConnectionGrantNotEnabled, false],
    [409, 'CONNECTION_NEEDS_REAUTH', ConnectionNeedsReauth, false],
    [502, 'CONNECTION_PROVIDER_UNAVAILABLE', ConnectionUnavailable, true],
    [403, 'CONNECTION_REQUIRES_AGENT_KEY', ConnectionAccessDenied, false],
  ] as const)(
    'maps %i %s to its class',
    async (status, code, Class, retryable) => {
      nock(HOST)
        .post(PATH)
        .reply(status, { detail: { code, message: 'said the server' } });
      const error = await connection(GOOGLE).catch((e: unknown) => e);
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

  it('maps a 403 out of scope (a key without the scope) to the generic error', async () => {
    // The key's route policy refuses with 403 AUTH_AGENT_KEY_OUT_OF_SCOPE. That is
    // not "no such connection": it must not arrive as ConnectionNotFound.
    nock(HOST)
      .post(PATH)
      .reply(403, {
        detail: {
          code: 'AUTH_AGENT_KEY_OUT_OF_SCOPE',
          message: 'this key cannot do that',
          required_scope: 'connections:token',
        },
      });
    const error = (await connection(GOOGLE).catch(
      (e: unknown) => e
    )) as ConnectionTokenError;
    expect(error.constructor).toBe(ConnectionTokenError);
    expect(error).not.toBeInstanceOf(ConnectionNotFound);
    expect([error.status, error.code]).toEqual([
      403,
      'AUTH_AGENT_KEY_OUT_OF_SCOPE',
    ]);
  });

  it("names a grant whose connections switch is off, apart from a key that is not the agent's", async () => {
    nock(HOST)
      .post(PATH)
      .reply(403, {
        detail: {
          code: 'CONNECTION_GRANT_NOT_ENABLED',
          message: 'the grant does not cover connections',
          connection_id: GOOGLE,
        },
      });
    const error = await connection(GOOGLE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionGrantNotEnabled);
    expect(error).not.toBeInstanceOf(ConnectionAccessDenied);
    expect((error as ConnectionGrantNotEnabled).detail.connection_id).toBe(
      GOOGLE
    );
  });

  it('reports an unrecognised pairing as it came', async () => {
    nock(HOST)
      .post(PATH)
      .reply(404, { detail: { code: 'AGENT_NOT_FOUND', message: 'gone' } });
    const error = (await connection(GOOGLE).catch(
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
    await connection(GOOGLE, { minValidSeconds: 60 });
    await expect(
      connection(GOOGLE, { minValidSeconds: 300 })
    ).rejects.toBeInstanceOf(ConnectionNeedsReauth);
    // Not served from the cache: the grant it came from is gone.
    expect(
      (await connection(GOOGLE, { minValidSeconds: 60 })).access_token
    ).toBe('new');
  });

  it.each([-1, 3001, 1.5])(
    'refuses minValidSeconds %p before any request',
    async value => {
      await expect(
        connection(GOOGLE, { minValidSeconds: value })
      ).rejects.toBeInstanceOf(AgentError);
    }
  );

  it('lists the usable connections from /connections/usable', async () => {
    let seen: { headers: Record<string, unknown> } | undefined;
    nock(HOST)
      .get('/api/v1/connections/usable')
      .reply(function () {
        seen = { headers: this.req.headers };
        return [
          200,
          [
            {
              id: GOOGLE,
              name: 'google',
              provider: 'google',
              scope: 'workspace',
              account_label: 'you@example.com',
              status: 'connected',
              scopes: ['openid'],
              used_by: null,
            },
          ],
        ];
      });
    const found = await listConnections();
    expect(seen?.headers.authorization).toBe('Bearer afy_test_agentkey');
    expect(found).toEqual([
      {
        id: GOOGLE,
        name: 'google',
        provider: 'google',
        scope: 'workspace',
        account_label: 'you@example.com',
        status: 'connected',
        scopes: ['openid'],
      },
    ]);
  });

  it('types the refusals of the list too', async () => {
    nock(HOST)
      .get('/api/v1/connections/usable')
      .reply(403, {
        detail: { code: 'CONNECTION_REQUIRES_AGENT_KEY', message: 'no' },
      });
    await expect(listConnections()).rejects.toBeInstanceOf(
      ConnectionAccessDenied
    );
  });

  it('says so off a machine', async () => {
    delete process.env.AETHERFY_API_KEY;
    await expect(connection(GOOGLE)).rejects.toBeInstanceOf(NotRunningOnAgent);
  });
});
