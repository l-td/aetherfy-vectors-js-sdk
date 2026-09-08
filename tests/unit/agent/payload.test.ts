/**
 * `payload()`: the file first, the HTTP fallback second, `{}` for no input.
 *
 * No network is touched — `fetch` is replaced. Nothing here asserts on the
 * double alone: every fallback test also checks the URL, the Bearer key and
 * the User-Agent that actually went out.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { payload } from '../../../src/agent';
import { PayloadUnavailable } from '../../../src/agent/errors';

const AGENT_VARS = [
  'AETHERFY_SPAWN_PAYLOAD_PATH',
  'AETHERFY_API_URL',
  'AETHERFY_SPAWN_ID',
  'AETHERFY_API_KEY',
];

let scratch: string;
const realFetch = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function writePayload(contents: string): string {
  const path = join(scratch, 'payload.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'aetherfy-agent-'));
  for (const name of AGENT_VARS) delete process.env[name];
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  global.fetch = realFetch;
});

describe('payload()', () => {
  it('reads the payload file', async () => {
    process.env.AETHERFY_SPAWN_PAYLOAD_PATH = writePayload(
      JSON.stringify({ date: '2026-09-07', items: [1, 2] })
    );

    await expect(payload()).resolves.toEqual({
      date: '2026-09-07',
      items: [1, 2],
    });
  });

  it('treats an empty file as an empty payload', async () => {
    // The normal case: a scheduled fire gets a file holding nothing.
    process.env.AETHERFY_SPAWN_PAYLOAD_PATH = writePayload('');

    await expect(payload()).resolves.toEqual({});
  });

  it('treats a file holding {} as an empty payload', async () => {
    process.env.AETHERFY_SPAWN_PAYLOAD_PATH = writePayload('{}');

    await expect(payload()).resolves.toEqual({});
  });

  it('treats a file holding null as an empty payload', async () => {
    process.env.AETHERFY_SPAWN_PAYLOAD_PATH = writePayload('null');

    await expect(payload()).resolves.toEqual({});
  });

  it('names the path when the file does not hold JSON', async () => {
    const path = writePayload('{not json');
    process.env.AETHERFY_SPAWN_PAYLOAD_PATH = path;

    await expect(payload()).rejects.toThrow(PayloadUnavailable);
    await expect(payload()).rejects.toThrow(path);
  });

  it('never makes a request when the file is readable', async () => {
    // A positive control for the mocking below: with a readable file the
    // transport is not called at all, so a fallback test that mocks fetch and
    // passes is genuinely exercising the fallback branch.
    process.env.AETHERFY_SPAWN_PAYLOAD_PATH = writePayload('{"a":1}');
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(payload()).resolves.toEqual({ a: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to HTTP when the variable is unset', async () => {
    process.env.AETHERFY_API_URL = 'https://agents.aetherfy.com/api/v1';
    process.env.AETHERFY_SPAWN_ID = 'dep-42';
    process.env.AETHERFY_API_KEY = 'afy_test_key';

    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { payload: { date: '2026-09-07' } })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(payload()).resolves.toEqual({ date: '2026-09-07' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://agents.aetherfy.com/api/v1/deployments/dep-42/payload'
    );
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer afy_test_key');
    // An explicit User-Agent, always: the default gets a 403 at the edge that
    // reads exactly like an auth failure.
    expect(init.headers['User-Agent']).toMatch(/^aetherfy-agent-js\//);
  });

  it('encodes the spawn id in the fallback URL', async () => {
    // Same rule as the run-reading calls: an id that carries a slash must not
    // silently become a request to another route.
    process.env.AETHERFY_API_URL = 'https://agents.aetherfy.com/api/v1';
    process.env.AETHERFY_SPAWN_ID = '../agents/other';
    process.env.AETHERFY_API_KEY = 'afy_test_key';

    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { payload: {} }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await payload();

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://agents.aetherfy.com/api/v1/deployments/' +
        '..%2Fagents%2Fother/payload'
    );
  });

  it('falls back to HTTP when the file is missing', async () => {
    // The variable is set but the machine never wrote the file — the exact
    // case the fallback exists for.
    process.env.AETHERFY_SPAWN_PAYLOAD_PATH = join(scratch, 'nope.json');
    process.env.AETHERFY_API_URL = 'https://agents.aetherfy.com/api/v1';
    process.env.AETHERFY_SPAWN_ID = 'dep-42';
    process.env.AETHERFY_API_KEY = 'afy_test_key';
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { payload: { from: 'fallback' } })
      ) as unknown as typeof fetch;

    await expect(payload()).resolves.toEqual({ from: 'fallback' });
  });

  it('returns {} when the fallback carries an empty payload', async () => {
    process.env.AETHERFY_API_URL = 'https://agents.aetherfy.com/api/v1';
    process.env.AETHERFY_SPAWN_ID = 'dep-42';
    process.env.AETHERFY_API_KEY = 'afy_test_key';
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { payload: {} })
      ) as unknown as typeof fetch;

    await expect(payload()).resolves.toEqual({});
  });

  it('raises when the fallback answers an error status', async () => {
    process.env.AETHERFY_API_URL = 'https://agents.aetherfy.com/api/v1';
    process.env.AETHERFY_SPAWN_ID = 'dep-42';
    process.env.AETHERFY_API_KEY = 'afy_test_key';
    // A FRESH Response per call: a body can only be read once, so a single
    // shared instance would make the second assertion fail on "Body is
    // unusable" rather than on what it is actually checking.
    global.fetch = jest.fn(async () =>
      jsonResponse(404, {
        detail: { code: 'DEPLOYMENT_NOT_FOUND', message: 'no such run' },
      })
    ) as unknown as typeof fetch;

    await expect(payload()).rejects.toThrow('404');
    await expect(payload()).rejects.toThrow('no such run');
  });

  it('raises when there is neither a file nor credentials', async () => {
    await expect(payload()).rejects.toThrow(PayloadUnavailable);
    await expect(payload()).rejects.toThrow('AETHERFY_SPAWN_PAYLOAD_PATH');
  });
});
