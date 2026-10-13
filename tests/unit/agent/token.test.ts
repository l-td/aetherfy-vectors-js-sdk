/**
 * `token()`: the exchange the control plane's route accepts, the cache in front
 * of it, and the refusals a caller branches on.
 *
 * Pinned against aetherfy-control-plane `api/routes/agent_tokens.py`:
 * `POST {api_prefix}/agent-tokens` with `{audience, scopes?}`, answered 201
 * with `{token, token_type, expires_at, audience, scopes}`, and the
 * `{"detail": {...}}` envelope for AGENT_TOKEN_AUDIENCE_UNKNOWN /
 * _SCOPE_NOT_GRANTED / AGENT_TOKENS_UNCONFIGURED / AGENT_TOKEN_REQUIRES_AGENT_KEY.
 */

import { token } from '../../../src/agent';
import { NotRunningOnAgent, TokenError } from '../../../src/agent/errors';

const AUDIENCE = 'aetherfy-control-plane';

const realFetch = global.fetch;
let fetchMock: jest.Mock;
let keyCounter = 0;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function minted(inSeconds: number, value = 'afyat_test_header.claims.sig') {
  return reply(201, {
    token: value,
    token_type: 'Bearer',
    expires_at: new Date(Date.now() + inSeconds * 1000).toISOString(),
    audience: AUDIENCE,
    scopes: ['runs:read'],
  });
}

beforeEach(() => {
  process.env.AETHERFY_API_URL = 'https://agents.aetherfy.com/api/v1/';
  // A fresh key per test: the cache is keyed by it, so no test can be served
  // a token another test minted.
  keyCounter += 1;
  process.env.AETHERFY_API_KEY = `afy_test_key_${keyCounter}`;
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.AETHERFY_API_URL;
  delete process.env.AETHERFY_API_KEY;
});

describe('token()', () => {
  it('sends the request the route accepts', async () => {
    fetchMock.mockResolvedValueOnce(minted(600));

    const result = await token({
      audience: AUDIENCE,
      scopes: ['runs:spawn', 'runs:read'],
    });

    expect(result.token).toBe('afyat_test_header.claims.sig');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://agents.aetherfy.com/api/v1/agent-tokens');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(
      `Bearer afy_test_key_${keyCounter}`
    );
    expect(JSON.parse(init.body)).toEqual({
      audience: AUDIENCE,
      scopes: ['runs:read', 'runs:spawn'],
    });
  });

  it('omits scopes when none are asked for', async () => {
    fetchMock.mockResolvedValueOnce(minted(600));
    await token({ audience: AUDIENCE });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      audience: AUDIENCE,
    });
  });

  it('serves a live token from the cache', async () => {
    fetchMock.mockResolvedValueOnce(minted(600));
    const first = await token({ audience: AUDIENCE, scopes: ['runs:read'] });
    const second = await token({ audience: AUDIENCE, scopes: ['runs:read'] });
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('replaces a token within a minute of expiry', async () => {
    fetchMock
      .mockResolvedValueOnce(minted(59, 'afyat_test_old'))
      .mockResolvedValueOnce(minted(600, 'afyat_test_new'));
    expect((await token({ audience: AUDIENCE })).token).toBe('afyat_test_old');
    expect((await token({ audience: AUDIENCE })).token).toBe('afyat_test_new');
  });

  it('caches per key, audience and scopes', async () => {
    fetchMock
      .mockResolvedValueOnce(minted(600, 'a'))
      .mockResolvedValueOnce(minted(600, 'b'))
      .mockResolvedValueOnce(minted(600, 'c'));
    expect(
      (await token({ audience: AUDIENCE, scopes: ['runs:read'] })).token
    ).toBe('a');
    expect(
      (await token({ audience: AUDIENCE, scopes: ['runs:spawn'] })).token
    ).toBe('b');
    // A task machine's next run brings a new key; the old run's token died with it.
    process.env.AETHERFY_API_KEY = 'afy_test_next_run';
    expect(
      (await token({ audience: AUDIENCE, scopes: ['runs:read'] })).token
    ).toBe('c');
  });

  it.each([
    [400, 'AGENT_TOKEN_AUDIENCE_UNKNOWN'],
    [403, 'AGENT_TOKEN_SCOPE_NOT_GRANTED'],
    [403, 'AGENT_TOKEN_REQUIRES_AGENT_KEY'],
    [503, 'AGENT_TOKENS_UNCONFIGURED'],
  ])('carries the platform code of a %i %s', async (status, code) => {
    fetchMock.mockResolvedValueOnce(
      reply(status, { detail: { code, message: 'no', not_granted: ['x'] } })
    );
    const error = await token({ audience: AUDIENCE }).catch(e => e);
    expect(error).toBeInstanceOf(TokenError);
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.detail.not_granted).toEqual(['x']);
  });

  it('does not cache a refusal', async () => {
    fetchMock
      .mockResolvedValueOnce(
        reply(503, { detail: { code: 'AGENT_TOKENS_UNCONFIGURED' } })
      )
      .mockResolvedValueOnce(minted(600));
    await expect(token({ audience: AUDIENCE })).rejects.toBeInstanceOf(
      TokenError
    );
    await expect(token({ audience: AUDIENCE })).resolves.toMatchObject({
      token: 'afyat_test_header.claims.sig',
    });
  });

  it('refuses an unreadable expiry rather than caching forever', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(201, { token: 't', expires_at: 'soon' })
    );
    await expect(token({ audience: AUDIENCE })).rejects.toBeInstanceOf(
      TokenError
    );
  });

  it('says which variable is missing off a machine', async () => {
    delete process.env.AETHERFY_API_KEY;
    await expect(token({ audience: AUDIENCE })).rejects.toBeInstanceOf(
      NotRunningOnAgent
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
