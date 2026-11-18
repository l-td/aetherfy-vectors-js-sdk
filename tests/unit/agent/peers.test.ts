/**
 * `agentUrl()`, `agentUrls()` and `callAgent()`: finding a peer at call time.
 *
 * The server side is built apart from this SDK, so the contract is mocked
 * exactly as it was specified:
 *
 *   GET <AETHERFY_PEERS_URL, {id} = this agent>/<name>
 *       200 {"name": ..., "url": ...}
 *       404 AGENT_NOT_FOUND, 409 PEER_HAS_NO_URL, 403 AUTH_AGENT_KEY_OUT_OF_SCOPE
 *   GET <AETHERFY_PEERS_URL, {id} = this agent>
 *       200 {"peers": [{"name": ..., "url": ...}]}
 *
 * ONE fetch stand-in plays both networks: a request to the control plane's
 * peers route is the lookup (counted), anything else is a peer (recorded, so
 * what it was sent, above all that it was NOT sent the Aetherfy key, is read
 * off the request).
 *
 * TIME NEVER PASSES BY WAITING. The cache takes an injected clock; a test moves
 * it by hand.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  agentUrl,
  agentUrls,
  callAgent,
  PEER_CACHE_SECONDS,
} from '../../../src/agent';
import * as agent from '../../../src/agent';
import { waiting } from '../../../src/agent/http';
import {
  AgentError,
  AgentTransportError,
  NotRunningOnAgent,
  PeerHasNoUrl,
  PeerLookupError,
  PeerNotFound,
} from '../../../src/agent/errors';
import { PEER_CACHE_SECONDS as CACHE_SECONDS_OF_CACHE } from '../../../src/agent/peers';
import {
  PEER_RETRY_CAP_SECONDS,
  PEER_RETRY_FLOOR_SECONDS,
  peerCache,
  retryDelay,
} from '../../../src/agent/peers';

const PEERS = 'https://agents.aetherfy.com/api/v1/agents/parent-agent-id/peers';
const KEY = 'afy_test_key_do_not_leak';

const OLD = 'https://analyst-k3m7x2.aetherfy.dev';
const NEW = 'https://analyst-q9w4h1.aetherfy.dev';
const INDEXER = 'https://indexer-a1b2c3.aetherfy.dev';

const realFetch = global.fetch;

/** The injected clock: a number a test moves, never a wait. */
const clock = {
  now: 1000,
  advance(seconds: number) {
    this.now += seconds;
  },
};

type Reply = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};
/** What a peer's base URL does: throw, answer, or a queue of those in turn. */
type Behaviour = Error | Reply | Response | Array<Error | Reply | Response>;

interface Call {
  url: string;
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: unknown;
    signal?: unknown;
    redirect?: string;
  };
}

let lookupCalls: Call[];
let peerCalls: Call[];
/** key (a peer name, or null for the list) -> the lookup's answer. */
let lookupReplies: Map<string | null, Reply | Reply[]>;
let behaviour: Map<string, Behaviour>;
let lookupRetryAfter: string | undefined;

function json(reply: Reply): Response {
  const body =
    typeof reply.body === 'string' || reply.body === null
      ? ((reply.body as string | null) ?? '')
      : JSON.stringify(reply.body);
  return new Response(body, { status: reply.status, headers: reply.headers });
}

function answer(name: string, url: string): void {
  lookupReplies.set(name, { status: 200, body: { name, url } });
}

function envelope(code: string, message = 'refused') {
  return { detail: { code, message } };
}

function fakeFetch(input: unknown, init: unknown): Promise<Response> {
  const url = String(input);
  const call = { url, init } as Call;
  if (url === PEERS || url.startsWith(`${PEERS}/`)) {
    lookupCalls.push(call);
    const key =
      url === PEERS ? null : decodeURIComponent(url.slice(PEERS.length + 1));
    // A list answers each lookup with its next reply, in order.
    const queued = lookupReplies.get(key);
    const reply = Array.isArray(queued) ? queued.shift() : queued;
    if (!reply) throw new Error(`no lookup reply for ${String(key)}`);
    const headers = { ...reply.headers };
    if (lookupRetryAfter) headers['Retry-After'] = lookupRetryAfter;
    return Promise.resolve(json({ ...reply, headers }));
  }
  peerCalls.push(call);
  const base = [...behaviour.keys()].find(b => url.startsWith(b));
  if (!base) throw new Error(`no behaviour for ${url}`);
  let current = behaviour.get(base) as Behaviour;
  if (Array.isArray(current))
    current = current.shift() as Error | Reply | Response;
  if (current instanceof Error) return Promise.reject(current);
  if (current instanceof Response) return Promise.resolve(current);
  return Promise.resolve(json(current));
}

beforeEach(() => {
  process.env.AETHERFY_PEERS_URL =
    'https://agents.aetherfy.com/api/v1/agents/{id}/peers';
  process.env.AETHERFY_AGENT_ID = 'parent-agent-id';
  process.env.AETHERFY_API_KEY = KEY;

  clock.now = 1000;
  peerCache.reset(() => clock.now);
  lookupCalls = [];
  peerCalls = [];
  lookupReplies = new Map();
  behaviour = new Map();
  lookupRetryAfter = undefined;
  answer('analyst', OLD);

  global.fetch = jest.fn(fakeFetch) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.AETHERFY_PEERS_URL;
  delete process.env.AETHERFY_AGENT_ID;
  delete process.env.AETHERFY_API_KEY;
  peerCache.reset();
});

/** A name that does not resolve: what Node's `fetch` rejects with, and the code that proves no peer was reached. */
const UNREACHABLE = Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), {
    code: 'ENOTFOUND',
  }),
});
const REFUSED_NOT_FOUND: Reply = {
  status: 404,
  body: { error: { code: 'AGENT_NOT_FOUND', message: 'gone' } },
};
const REFUSED_NOT_REACHABLE: Reply = {
  status: 404,
  body: { error: { code: 'AGENT_NOT_REACHABLE' } },
};

describe('agentUrl()', () => {
  it('sends the request the route accepts', async () => {
    await expect(agentUrl('analyst')).resolves.toBe(OLD);

    const { url, init } = lookupCalls[0];
    expect(init.method).toBe('GET');
    // THE VARIABLE IS A TEMPLATE, resolved with this machine's own agent id.
    expect(url).toBe(`${PEERS}/analyst`);
    expect(url).not.toContain('{id}');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.headers['User-Agent']).toMatch(/^aetherfy-agent-js\//);
    expect(init.body).toBeUndefined();
  });

  it('quotes the name into the path', async () => {
    lookupReplies.set('a/b c', {
      status: 200,
      body: { name: 'a/b c', url: OLD },
    });

    await agentUrl('a/b c');

    expect(lookupCalls[0].url).toBe(`${PEERS}/a%2Fb%20c`);
  });

  it('leaves an already-resolved URL alone', async () => {
    process.env.AETHERFY_PEERS_URL =
      'https://agents.aetherfy.com/api/v1/agents/parent-agent-id/peers/';
    delete process.env.AETHERFY_AGENT_ID;

    await agentUrl('analyst');

    expect(lookupCalls[0].url).toBe(`${PEERS}/analyst`);
  });

  it('serves a fresh answer without a second lookup', async () => {
    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    await expect(agentUrl('analyst')).resolves.toBe(OLD);

    expect(lookupCalls).toHaveLength(1);
  });

  it('keeps the cache window at thirty seconds, readable from the entry point', () => {
    expect(PEER_CACHE_SECONDS).toBe(30);
    expect(CACHE_SECONDS_OF_CACHE).toBe(PEER_CACHE_SECONDS);
  });

  it('keys the cache by name', async () => {
    answer('indexer', INDEXER);

    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    await expect(agentUrl('indexer')).resolves.toBe(INDEXER);
    await expect(agentUrl('analyst')).resolves.toBe(OLD);

    expect(lookupCalls.map(c => c.url)).toEqual([
      `${PEERS}/analyst`,
      `${PEERS}/indexer`,
    ]);
  });

  it('serves the entry until the window closes and not after', async () => {
    await agentUrl('analyst');
    clock.advance(PEER_CACHE_SECONDS - 0.001);
    await agentUrl('analyst');
    expect(lookupCalls).toHaveLength(1);

    clock.advance(0.001);
    await agentUrl('analyst');
    expect(lookupCalls).toHaveLength(2);
  });

  it('runs the window from the lookup, not from the last read', async () => {
    // A busy caller must not keep an address alive forever by reading it.
    await agentUrl('analyst'); // t = 0
    clock.advance(14);
    await agentUrl('analyst'); // t = 14: a read, which must not renew the entry
    clock.advance(14);
    await agentUrl('analyst'); // t = 28
    expect(lookupCalls).toHaveLength(1);

    clock.advance(2);
    await agentUrl('analyst'); // t = 30, thirty seconds after the LOOKUP
    expect(lookupCalls).toHaveLength(2);
  });

  it('skips the cache and replaces the entry with fresh', async () => {
    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    answer('analyst', NEW);

    await expect(agentUrl('analyst')).resolves.toBe(OLD); // inside the window
    await expect(agentUrl('analyst', { fresh: true })).resolves.toBe(NEW);
    expect(lookupCalls).toHaveLength(2);

    // The refresh REPLACED the entry: the next plain call is served it.
    await expect(agentUrl('analyst')).resolves.toBe(NEW);
    expect(lookupCalls).toHaveLength(2);
  });

  it('finds a recreated peer after the window', async () => {
    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    answer('analyst', NEW); // the peer was deleted and created again

    clock.advance(PEER_CACHE_SECONDS);

    await expect(agentUrl('analyst')).resolves.toBe(NEW);
  });

  it('finds a recreated peer at once with fresh', async () => {
    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    answer('analyst', NEW);

    await expect(agentUrl('analyst', { fresh: true })).resolves.toBe(NEW);
  });

  it('does not cache a refusal', async () => {
    lookupReplies.set('analyst', {
      status: 404,
      body: envelope('AGENT_NOT_FOUND'),
    });
    await expect(agentUrl('analyst')).rejects.toBeInstanceOf(PeerNotFound);

    answer('analyst', OLD); // the peer is created a moment later

    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    expect(lookupCalls).toHaveLength(2);
  });

  it('leaves the entry alone when a refresh fails', async () => {
    await agentUrl('analyst');
    lookupReplies.set('analyst', {
      status: 404,
      body: envelope('AGENT_NOT_FOUND'),
    });

    await expect(agentUrl('analyst', { fresh: true })).rejects.toBeInstanceOf(
      PeerNotFound
    );

    lookupReplies.set('analyst', { status: 500, body: null });
    await expect(agentUrl('analyst')).resolves.toBe(OLD); // nothing was asked
    expect(lookupCalls).toHaveLength(2);
  });

  it.each([
    [404, 'AGENT_NOT_FOUND', PeerNotFound],
    [409, 'PEER_HAS_NO_URL', PeerHasNoUrl],
    [403, 'AUTH_AGENT_KEY_OUT_OF_SCOPE', PeerLookupError],
  ])('maps %i %s to its exception', async (status, code, expected) => {
    lookupReplies.set('analyst', {
      status,
      body: envelope(code, 'prose that may change'),
    });

    const error = await agentUrl('analyst').catch(e => e);

    expect(error).toBeInstanceOf(PeerLookupError);
    expect(error.constructor).toBe(expected);
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.message).toContain('prose that may change');
    expect(error.detail.code).toBe(code);
  });

  it.each([
    // THE PAIRING SELECTS THE TYPE: the status alone, or the code on another
    // status, must not wear a type whose code the platform never sent with it.
    [404, 'SOMETHING_ELSE'],
    [404, undefined],
    [409, 'SOMETHING_ELSE'],
    [409, 'AGENT_NOT_FOUND'],
    [403, 'AGENT_NOT_FOUND'],
    [500, 'PEER_HAS_NO_URL'],
  ])(
    'treats %i with code %s as a plain PeerLookupError',
    async (status, code) => {
      lookupReplies.set('analyst', {
        status,
        body: code ? envelope(code) : { detail: 'x' },
      });

      const error = await agentUrl('analyst').catch(e => e);

      expect(error.constructor).toBe(PeerLookupError);
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
    }
  );

  it('carries Retry-After from a refusal', async () => {
    lookupReplies.set('analyst', {
      status: 503,
      body: envelope('SERVICE_UNAVAILABLE'),
    });
    lookupRetryAfter = '7';

    const error = await agentUrl('analyst').catch(e => e);

    expect(error.retryAfter).toBe(7);
  });

  it('makes the peer errors agent errors', () => {
    for (const exc of [PeerNotFound, PeerHasNoUrl, PeerLookupError]) {
      expect(exc.prototype).toBeInstanceOf(AgentError);
    }
    expect(PeerNotFound.prototype).toBeInstanceOf(PeerLookupError);
    expect(PeerHasNoUrl.prototype).toBeInstanceOf(PeerLookupError);
    expect(PeerNotFound.prototype).not.toBeInstanceOf(PeerHasNoUrl);
    // And the entry point exports all three.
    expect(agent.PeerNotFound).toBe(PeerNotFound);
    expect(agent.PeerHasNoUrl).toBe(PeerHasNoUrl);
    expect(agent.PeerLookupError).toBe(PeerLookupError);
  });

  it.each([
    [{ name: 'analyst' }],
    [{ name: 'analyst', url: '' }],
    [{ name: 'analyst', url: 7 }],
    [['not', 'an', 'object']],
    [null],
  ])(
    'treats a 200 with no address (%j) as an error, not undefined',
    async body => {
      lookupReplies.set('analyst', { status: 200, body });

      const error = await agentUrl('analyst').catch(e => e);

      expect(error).toBeInstanceOf(PeerLookupError);
      expect(error.status).toBe(200);
      expect(lookupCalls).toHaveLength(1);
      // And nothing was remembered from it.
      answer('analyst', OLD);
      await expect(agentUrl('analyst')).resolves.toBe(OLD);
    }
  );

  it.each(['AETHERFY_PEERS_URL', 'AETHERFY_API_KEY', 'AETHERFY_AGENT_ID'])(
    'gives the helpful error spawn gives when %s is missing',
    async variable => {
      delete process.env[variable];

      const error = await agentUrl('analyst').catch(e => e);

      expect(error).toBeInstanceOf(NotRunningOnAgent);
      expect(error.variable).toBe(variable);
      expect(error.message).toContain(variable);
      expect(error.message).toContain('Aetherfy agent');
      expect(lookupCalls).toHaveLength(0);
    }
  );

  it('needs no environment to serve a fresh answer', async () => {
    await agentUrl('analyst');
    delete process.env.AETHERFY_PEERS_URL;

    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    await expect(agentUrl('analyst', { fresh: true })).rejects.toBeInstanceOf(
      NotRunningOnAgent
    );
  });

  it('refuses an empty name before any request', async () => {
    await expect(agentUrl('')).rejects.toBeInstanceOf(AgentError);
    expect(lookupCalls).toHaveLength(0);
  });

  it('refuses an unknown option like every other options object', async () => {
    await expect(
      agentUrl('analyst', { fresh: true, fresher: true } as never)
    ).rejects.toThrow(TypeError);
    expect(lookupCalls).toHaveLength(0);
  });
});

describe('agentUrls()', () => {
  const LISTED = {
    peers: [
      { name: 'analyst', url: OLD },
      { name: 'indexer', url: INDEXER },
    ],
  };

  beforeEach(() => {
    lookupReplies.set(null, { status: 200, body: LISTED });
  });

  it('sends the request the route accepts', async () => {
    await expect(agentUrls()).resolves.toEqual({
      analyst: OLD,
      indexer: INDEXER,
    });

    const { url, init } = lookupCalls[0];
    expect(init.method).toBe('GET');
    expect(url).toBe(PEERS);
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('remembers an empty workspace too', async () => {
    lookupReplies.set(null, { status: 200, body: { peers: [] } });

    await expect(agentUrls()).resolves.toEqual({});
    await expect(agentUrls()).resolves.toEqual({});
    expect(lookupCalls).toHaveLength(1);
  });

  it('is one cache entry with the same window', async () => {
    await agentUrls();
    await agentUrls();
    expect(lookupCalls).toHaveLength(1);

    clock.advance(PEER_CACHE_SECONDS - 0.001);
    await agentUrls();
    expect(lookupCalls).toHaveLength(1);

    clock.advance(0.001);
    await agentUrls();
    expect(lookupCalls).toHaveLength(2);
  });

  it('refreshes with fresh', async () => {
    await agentUrls();
    lookupReplies.set(null, {
      status: 200,
      body: { peers: [{ name: 'analyst', url: NEW }] },
    });

    await expect(agentUrls()).resolves.toEqual({
      analyst: OLD,
      indexer: INDEXER,
    });
    await expect(agentUrls({ fresh: true })).resolves.toEqual({ analyst: NEW });
    await expect(agentUrls()).resolves.toEqual({ analyst: NEW });
    expect(lookupCalls).toHaveLength(2);
  });

  it('finds a recreated peer after the window', async () => {
    await agentUrls();
    lookupReplies.set(null, {
      status: 200,
      body: { peers: [{ name: 'analyst', url: NEW }] },
    });
    clock.advance(PEER_CACHE_SECONDS);

    await expect(agentUrls()).resolves.toEqual({ analyst: NEW });
  });

  it('hands out copies, so editing one does not edit the cache', async () => {
    const first = await agentUrls();
    first.intruder = 'https://evil.example';
    first.analyst = 'https://evil.example';

    const again = await agentUrls();
    expect(again).not.toHaveProperty('intruder');
    expect(again.analyst).toBe(OLD);
    again.x = 'y';
    await expect(agentUrls()).resolves.not.toHaveProperty('x');
  });

  it('keeps the list and a name as separate memories', async () => {
    await agentUrls();
    expect(lookupCalls).toHaveLength(1);

    await expect(agentUrl('analyst')).resolves.toBe(OLD); // not from the list
    expect(lookupCalls).toHaveLength(2);

    await agentUrl('analyst');
    await agentUrls();
    expect(lookupCalls).toHaveLength(2);
  });

  it.each([
    [403, 'AUTH_AGENT_KEY_OUT_OF_SCOPE', PeerLookupError],
    [404, 'AGENT_NOT_FOUND', PeerNotFound],
    [409, 'PEER_HAS_NO_URL', PeerHasNoUrl],
  ])('maps %i %s as a name does', async (status, code, expected) => {
    lookupReplies.set(null, { status, body: envelope(code) });

    const error = await agentUrls().catch(e => e);

    expect(error.constructor).toBe(expected);
    expect(error.code).toBe(code);
  });

  it.each([
    [{}],
    [{ peers: 'analyst' }],
    [{ peers: [{ name: 'analyst' }] }],
    [{ peers: [{ url: OLD }] }],
    [{ peers: ['analyst'] }],
    [{ peers: [{ name: '', url: OLD }] }],
    [['x']],
  ])('refuses a malformed list (%j) and remembers nothing', async body => {
    lookupReplies.set(null, { status: 200, body });
    await expect(agentUrls()).rejects.toBeInstanceOf(PeerLookupError);

    lookupReplies.set(null, { status: 200, body: LISTED });
    expect(Object.keys(await agentUrls())).toHaveLength(2);
    expect(lookupCalls).toHaveLength(2);
  });

  it('needs the same environment', async () => {
    delete process.env.AETHERFY_PEERS_URL;

    const error = await agentUrls().catch(e => e);

    expect(error).toBeInstanceOf(NotRunningOnAgent);
    expect(error.variable).toBe('AETHERFY_PEERS_URL');
  });
});

describe('callAgent()', () => {
  function reachable(base: string, reply: Reply = { status: 200, body: 'ok' }) {
    behaviour.set(base, reply);
  }

  it('sends the request to the url plus the path', async () => {
    reachable(OLD, { status: 200, body: { ok: true } });

    const response = await callAgent('analyst', '/summarise?depth=2', {
      method: 'POST',
      json: { id: 7 },
      headers: { 'X-Trace': 't-1' },
      timeout: 5,
    });

    const { url, init } = peerCalls[0];
    expect(url).toBe(`${OLD}/summarise?depth=2`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ id: 7 });
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-Trace']).toBe('t-1');
    expect(init.headers['User-Agent']).toMatch(/^aetherfy-agent-js\//);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(response.status).toBe(200);
  });

  it('sends no body on a GET and does not double a trailing slash', async () => {
    answer('analyst', `${OLD}/`);
    reachable(OLD);

    await callAgent('analyst', '/health');

    const { url, init } = peerCalls[0];
    expect(url).toBe(`${OLD}/health`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  it('keeps a Content-Type the caller names, in any case', async () => {
    reachable(OLD);

    await callAgent('analyst', '/x', {
      method: 'PUT',
      json: [1, 2],
      headers: { 'content-type': 'application/vnd.api+json' },
    });

    const headers = peerCalls[0].init.headers;
    expect(headers['content-type']).toBe('application/vnd.api+json');
    expect(
      Object.keys(headers).filter(k => k.toLowerCase() === 'content-type')
    ).toHaveLength(1);
  });

  it('treats false, 0 and null as bodies; only undefined is the absence', async () => {
    reachable(OLD);

    await callAgent('analyst', '/x', { method: 'POST', json: false });
    await callAgent('analyst', '/x', { method: 'POST', json: 0 });
    await callAgent('analyst', '/x', { method: 'POST', json: null });
    await callAgent('analyst', '/x', { method: 'POST', json: undefined });

    expect(peerCalls.map(c => c.init.body)).toEqual([
      'false',
      '0',
      'null',
      undefined,
    ]);
  });

  it('never sends the Aetherfy key to the peer', async () => {
    reachable(OLD);

    await callAgent('analyst', '/x', {
      method: 'POST',
      json: { id: 7 },
      headers: { 'X-A': 'b' },
    });

    const { url, init } = peerCalls[0];
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.headers).not.toHaveProperty('authorization');
    expect(JSON.stringify(init.headers)).not.toContain(KEY);
    expect(url).not.toContain(KEY);
    expect(String(init.body)).not.toContain(KEY);
  });

  it('sends the key to every lookup, the re-resolve included, and to no peer attempt', async () => {
    behaviour.set(OLD, UNREACHABLE);
    reachable(NEW);
    await agentUrl('analyst');
    answer('analyst', NEW);

    await callAgent('analyst', '/x'); // OLD is down; the re-resolve finds NEW

    expect(peerCalls).toHaveLength(2);
    expect(lookupCalls).toHaveLength(2);
    for (const call of lookupCalls) {
      expect(call.init.headers.Authorization).toBe(`Bearer ${KEY}`);
    }
    for (const call of peerCalls) {
      expect(JSON.stringify(call.init.headers)).not.toContain(KEY);
    }
  });

  it('returns a small response object', async () => {
    reachable(OLD, {
      status: 201,
      body: { summary: 'done' },
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'r-9' },
    });

    const response = await callAgent('analyst', '/x');

    expect(response.status).toBe(201);
    expect(response.headers).toMatchObject({
      'content-type': 'application/json',
      'x-request-id': 'r-9',
    });
    expect(response.text).toBe('{"summary":"done"}');
    expect(response.json()).toEqual({ summary: 'done' });
  });

  it('throws from json() on a body that is not JSON', async () => {
    reachable(OLD, { status: 200, body: 'plain text' });

    const response = await callAgent('analyst', '/x');

    expect(response.text).toBe('plain text');
    expect(() => response.json()).toThrow(SyntaxError);
  });

  it('uses the cache for the lookup', async () => {
    reachable(OLD);

    await callAgent('analyst', '/x');
    await callAgent('analyst', '/y');
    await callAgent('analyst', '/z');

    expect(lookupCalls).toHaveLength(1);
    expect(peerCalls).toHaveLength(3);
  });

  const withCause = (code: string, message: string) =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(message), { code }),
    });

  it.each([
    ['dns', withCause('ENOTFOUND', 'getaddrinfo ENOTFOUND')],
    ['dns-again', withCause('EAI_AGAIN', 'getaddrinfo EAI_AGAIN')],
    ['refused', withCause('ECONNREFUSED', 'connect ECONNREFUSED')],
  ])(
    're-resolves once when no peer was reached (%s)',
    async (_label, failure) => {
      behaviour.set(OLD, failure);
      reachable(NEW, { status: 200, body: { ok: true } });
      await agentUrl('analyst'); // the cache now holds OLD
      answer('analyst', NEW); // the peer was recreated meanwhile
      const before = lookupCalls.length;

      const response = await callAgent('analyst', '/x');

      expect(response.status).toBe(200);
      expect(peerCalls.map(c => c.url)).toEqual([`${OLD}/x`, `${NEW}/x`]);
      // One extra lookup, and it was a FRESH one: the cache still held OLD.
      expect(lookupCalls).toHaveLength(before + 1);
      expect(lookupCalls[lookupCalls.length - 1].url).toBe(`${PEERS}/analyst`);
      // The re-resolve replaced the entry: the next call needs no lookup.
      await callAgent('analyst', '/y');
      expect(lookupCalls).toHaveLength(before + 1);
      expect(peerCalls[peerCalls.length - 1].url).toBe(`${NEW}/y`);
    }
  );

  it.each([
    ['reset', withCause('ECONNRESET', 'read ECONNRESET')],
    [
      'timeout',
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
    ],
    ['a failure with no cause', new TypeError('fetch failed')],
  ])(
    'does not replay a request after %s, because the peer may have acted',
    async (_label, failure) => {
      behaviour.set(OLD, failure);
      reachable(NEW, { status: 200, body: { ok: true } });
      await agentUrl('analyst');
      answer('analyst', NEW);
      const before = lookupCalls.length;

      await expect(
        callAgent('analyst', '/charge', { method: 'POST', json: { cents: 5 } })
      ).rejects.toThrow(/may or may not have run/);

      // Exactly ONE request left the machine, and no second lookup was made.
      expect(peerCalls.map(c => c.url)).toEqual([`${OLD}/charge`]);
      expect(lookupCalls).toHaveLength(before);
    }
  );

  it.each([
    ['not-found', REFUSED_NOT_FOUND],
    ['not-reachable', REFUSED_NOT_REACHABLE],
  ])(
    're-resolves once when the edge refuses a retired address (%s)',
    async (_label, refusal) => {
      behaviour.set(OLD, refusal);
      reachable(NEW, { status: 200, body: { ok: true } });
      await agentUrl('analyst');
      answer('analyst', NEW);

      const response = await callAgent('analyst', '/x', {
        method: 'POST',
        json: { a: 1 },
      });

      expect(response.status).toBe(200);
      expect(peerCalls.map(c => c.url)).toEqual([`${OLD}/x`, `${NEW}/x`]);
      // The retry carries the same method and body.
      expect(peerCalls.map(c => c.init.method)).toEqual(['POST', 'POST']);
      expect(peerCalls.map(c => c.init.body)).toEqual(['{"a":1}', '{"a":1}']);
      expect(lookupCalls).toHaveLength(2);
    }
  );

  it.each<[number, unknown]>([
    [500, 'boom'],
    [502, { detail: 'bad gateway' }],
    [503, { error: { code: 'AGENT_NOT_REACHABLE' } }], // 503 is not the refusal
    [404, 'not json at all'],
    [404, { error: { code: 'ROUTE_NOT_FOUND' } }], // the peer's own 404
    [404, { detail: { code: 'AGENT_NOT_FOUND' } }], // not the edge's envelope
    [404, { error: 'AGENT_NOT_FOUND' }],
    [404, ['AGENT_NOT_FOUND']],
    [404, null],
    [403, { error: { code: 'AGENT_NOT_FOUND' } }],
    [200, { error: { code: 'AGENT_NOT_FOUND' } }],
    [400, { error: { code: 'BAD' } }],
  ])('returns %i %j as is and never retries it', async (status, body) => {
    behaviour.set(OLD, { status, body });

    const response = await callAgent('analyst', '/x');

    expect(response.status).toBe(status);
    expect(peerCalls).toHaveLength(1);
    expect(lookupCalls).toHaveLength(1);
  });

  it('throws on a second connect failure and stops', async () => {
    behaviour.set(OLD, UNREACHABLE);
    behaviour.set(
      NEW,
      Object.assign(new TypeError('fetch failed again'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      })
    );
    await agentUrl('analyst');
    answer('analyst', NEW);

    const error = await callAgent('analyst', '/x').catch(e => e);

    expect(error).toBeInstanceOf(AgentTransportError);
    expect(error.message).toContain('fetch failed again');
    expect(peerCalls.map(c => c.url)).toEqual([`${OLD}/x`, `${NEW}/x`]); // not a third
    expect(lookupCalls).toHaveLength(2);
  });

  it('throws on a second refusal and stops', async () => {
    behaviour.set(OLD, REFUSED_NOT_REACHABLE);
    behaviour.set(NEW, REFUSED_NOT_FOUND);
    await agentUrl('analyst');
    answer('analyst', NEW);

    const error = await callAgent('analyst', '/x').catch(e => e);

    expect(error).toBeInstanceOf(AgentTransportError);
    expect(error.message).toContain('AGENT_NOT_FOUND');
    expect(peerCalls.map(c => c.url)).toEqual([`${OLD}/x`, `${NEW}/x`]);
  });

  it('returns whatever status the second attempt gets', async () => {
    behaviour.set(OLD, UNREACHABLE);
    behaviour.set(NEW, { status: 500, body: 'boom' });
    await agentUrl('analyst');
    answer('analyst', NEW);

    const response = await callAgent('analyst', '/x');

    expect(response.status).toBe(500);
    expect(peerCalls).toHaveLength(2);
  });

  it('tries the same address once more when the fresh lookup answers it again', async () => {
    // A blip, not a recreation.
    behaviour.set(OLD, [UNREACHABLE, { status: 200, body: 'ok' }]);

    const response = await callAgent('analyst', '/x');

    expect(response.status).toBe(200);
    expect(peerCalls.map(c => c.url)).toEqual([`${OLD}/x`, `${OLD}/x`]);
    expect(lookupCalls).toHaveLength(2);
  });

  it('surfaces a peer that the re-resolve cannot find', async () => {
    behaviour.set(OLD, REFUSED_NOT_FOUND);
    await agentUrl('analyst');
    lookupReplies.set('analyst', {
      status: 404,
      body: envelope('AGENT_NOT_FOUND'),
    });

    await expect(callAgent('analyst', '/x')).rejects.toBeInstanceOf(
      PeerNotFound
    );
    expect(peerCalls).toHaveLength(1);
  });

  it('raises before any peer request when the peer has no url', async () => {
    lookupReplies.set('analyst', {
      status: 409,
      body: envelope('PEER_HAS_NO_URL'),
    });

    await expect(callAgent('analyst', '/x')).rejects.toBeInstanceOf(
      PeerHasNoUrl
    );
    expect(peerCalls).toHaveLength(0);
  });

  it('does not retry a body that dies after the status arrived', async () => {
    // The peer answered. A retry could repeat what it already did.
    const dying = new Response('', { status: 200 });
    Object.defineProperty(dying, 'text', {
      value: () => Promise.reject(new Error('reset mid-body')),
    });
    behaviour.set(OLD, dying);

    const error = await callAgent('analyst', '/x', {
      method: 'POST',
      json: { charge: 1 },
    }).catch(e => e);

    expect(error).toBeInstanceOf(AgentTransportError);
    expect(error.message).toContain('reset mid-body');
    expect(peerCalls).toHaveLength(1);
    expect(lookupCalls).toHaveLength(1);
  });

  it.each(['summarise', '', 'http://evil.example/x'])(
    'requires the path to start with a slash (%j)',
    async path => {
      await expect(callAgent('analyst', path)).rejects.toBeInstanceOf(
        AgentError
      );
      expect(peerCalls).toHaveLength(0);
      expect(lookupCalls).toHaveLength(0);
    }
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'requires a positive finite timeout (%s)',
    async timeout => {
      await expect(
        callAgent('analyst', '/x', { timeout })
      ).rejects.toBeInstanceOf(AgentError);
      expect(peerCalls).toHaveLength(0);
      expect(lookupCalls).toHaveLength(0);
    }
  );

  it('asks fetch not to follow a redirect', async () => {
    reachable(OLD);

    await callAgent('analyst', '/x');

    expect(peerCalls[0].init.redirect).toBe('manual');
  });

  it('refuses an unknown init key', async () => {
    await expect(
      callAgent('analyst', '/x', { body: 'x' } as never)
    ).rejects.toThrow(TypeError);
    expect(peerCalls).toHaveLength(0);
  });

  it('needs the lookup environment', async () => {
    delete process.env.AETHERFY_PEERS_URL;

    const error = await callAgent('analyst', '/x').catch(e => e);

    expect(error).toBeInstanceOf(NotRunningOnAgent);
    expect(error.variable).toBe('AETHERFY_PEERS_URL');
    expect(peerCalls).toHaveLength(0);
  });
});

describe('over a real socket (loopback only)', () => {
  it('re-resolves a dead address to the live one', async () => {
    // The one test that opens sockets, on 127.0.0.1 only: a real refused
    // connection, a real server, nothing else on the network.
    global.fetch = realFetch;
    const seen: Array<{
      path: string | undefined;
      headers: Record<string, unknown>;
      body: string;
    }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += String(chunk)));
      req.on('end', () => {
        seen.push({ path: req.url, headers: { ...req.headers }, body });
        const payload = JSON.stringify({ echo: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const live = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // A port nothing listens on: bind it, read the number, close it.
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const dead = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
    await new Promise<void>(resolve => probe.close(() => resolve()));

    // The lookup still goes to the stand-in; only the peer is real.
    const lookupOnly = jest.fn((input: unknown, init: unknown) => {
      const url = String(input);
      if (url.startsWith(PEERS)) return fakeFetch(input, init);
      return realFetch(input as string, init as Parameters<typeof fetch>[1]);
    });
    global.fetch = lookupOnly as unknown as typeof fetch;

    try {
      answer('analyst', dead);
      await agentUrl('analyst');
      answer('analyst', live); // recreated, now at the live address

      const response = await callAgent('analyst', '/echo', {
        method: 'POST',
        json: { n: 1 },
        timeout: 10,
      });

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ echo: { n: 1 } });
      expect(seen).toHaveLength(1);
      expect(seen[0].path).toBe('/echo');
      expect(JSON.stringify(seen[0].headers)).not.toContain(KEY);
      expect(seen[0].headers).not.toHaveProperty('authorization');
      expect(lookupCalls).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['GET', 'POST', 'PUT'])(
    'returns a redirect to a %s instead of following it',
    async method => {
      // A 3xx is the peer's answer. Following it would replay a 307/308 body
      // wherever `Location` points.
      global.fetch = realFetch;
      const seen: Array<[string | undefined, string | undefined]> = [];
      const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          seen.push([req.method, req.url]);
          res.writeHead(307, { Location: '/elsewhere', 'Content-Length': '0' });
          res.end();
        });
      });
      await new Promise<void>(resolve =>
        server.listen(0, '127.0.0.1', resolve)
      );
      const live = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const lookupOnly = jest.fn((input: unknown, init: unknown) =>
        String(input).startsWith(PEERS)
          ? fakeFetch(input, init)
          : realFetch(input as string, init as Parameters<typeof fetch>[1])
      );
      global.fetch = lookupOnly as unknown as typeof fetch;

      try {
        answer('analyst', live);

        const response = await callAgent('analyst', '/moved', {
          method,
          json: method === 'GET' ? undefined : { n: 1 },
          headers: { 'X-Mine': '1' },
          timeout: 10,
        });

        expect(response.status).toBe(307);
        expect(response.headers.location).toBe('/elsewhere');
        // ONE request reached the peer: the redirect was not followed.
        expect(seen).toEqual([[method, '/moved']]);
        expect(lookupCalls).toHaveLength(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
  );
});

// ------------------------------------------- a control plane that cannot answer
//
// A looked-up address outlives its window as the LAST KNOWN ONE and is served when the control plane
// cannot answer (429, 5xx, no connection), and the control plane is not asked again before its
// Retry-After. Every test counts lookups (events) and moves the injected clock; none waits.

describe('a control plane that cannot answer', () => {
  const WINDOW_PAST = PEER_CACHE_SECONDS + 1;
  const unwell = (status: number): Reply => ({
    status,
    body: envelope('SERVICE_UNAVAILABLE'),
  });

  async function knownThenExpired(): Promise<void> {
    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    clock.advance(WINDOW_PAST);
  }

  it.each([
    [429, '7'],
    [500, undefined],
    [503, '7'],
    [502, undefined],
  ])(
    'serves the last known address when the lookup answers %s',
    async (status, retryAfter) => {
      await knownThenExpired();
      lookupReplies.set('analyst', unwell(status));
      lookupRetryAfter = retryAfter;

      await expect(agentUrl('analyst')).resolves.toBe(OLD);

      expect(lookupCalls).toHaveLength(2); // asked once, was refused, served the known address
    }
  );

  it('serves the last known address when the control plane is unreachable', async () => {
    await knownThenExpired();
    const calls = lookupCalls.length;
    (global.fetch as jest.Mock).mockImplementationOnce(() => {
      throw new TypeError('fetch failed');
    });
    (global.fetch as jest.Mock).mockImplementationOnce(() => {
      throw new TypeError('fetch failed');
    });

    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    expect(lookupCalls).toHaveLength(calls); // neither attempt reached the fake lookup
    // and the failure is waited out, not repeated on the next call
    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    expect(lookupCalls).toHaveLength(calls);
  });

  it('does not ask again before the Retry-After, and asks again after it', async () => {
    await knownThenExpired();
    lookupReplies.set('analyst', unwell(429));
    lookupRetryAfter = '10';
    await agentUrl('analyst');
    const asked = lookupCalls.length;

    clock.advance(9.9);
    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    expect(lookupCalls).toHaveLength(asked); // waiting: no request

    answer('analyst', NEW);
    lookupRetryAfter = undefined;
    clock.advance(0.1);
    await expect(agentUrl('analyst')).resolves.toBe(NEW);
    expect(lookupCalls).toHaveLength(asked + 1);
  });

  it.each([
    ['none waits the floor', undefined, PEER_RETRY_FLOOR_SECONDS],
    ['a long one is capped', '3600', PEER_RETRY_CAP_SECONDS],
    ['one in range is honoured', '20', 20],
  ])('%s', async (_label, retryAfter, waits) => {
    await knownThenExpired();
    lookupReplies.set('analyst', unwell(503));
    lookupRetryAfter = retryAfter;
    await agentUrl('analyst');
    const asked = lookupCalls.length;

    clock.advance(waits - 0.01);
    await agentUrl('analyst');
    expect(lookupCalls).toHaveLength(asked);
    clock.advance(0.02);
    await agentUrl('analyst');
    expect(lookupCalls).toHaveLength(asked + 1);
  });

  it.each([
    ['none', undefined, 5],
    ['zero', 0, 5],
    ['one', 1, 5],
    ['4.9', 4.9, 5],
    ['negative', -3, 5],
    ['NaN', NaN, 5],
    ['5', 5, 5],
    ['20', 20, 20],
    ['60', 60, 60],
    ['120', 120, 60],
  ])('retryDelay clamps both ends: %s', (_label, retryAfter, waits) => {
    // The floor applies to a GIVEN Retry-After too: the control plane's own limiter sends small values,
    // and a wait of 0 would give a sick control plane a lookup on every call.
    expect(retryDelay(retryAfter)).toBe(waits);
  });

  it.each([['0'], ['1'], ['4.9'], ['-3']])(
    'a Retry-After of %s still waits the floor before asking again',
    async retryAfter => {
      await knownThenExpired();
      lookupReplies.set('analyst', unwell(429));
      lookupRetryAfter = retryAfter;
      await agentUrl('analyst');
      const asked = lookupCalls.length;

      clock.advance(PEER_RETRY_FLOOR_SECONDS - 0.01);
      await expect(agentUrl('analyst')).resolves.toBe(OLD);
      expect(lookupCalls).toHaveLength(asked); // still waiting: no request

      clock.advance(0.02);
      await agentUrl('analyst');
      expect(lookupCalls).toHaveLength(asked + 1);
    }
  );

  it.each([
    [403, 'AUTH_AGENT_KEY_OUT_OF_SCOPE'],
    [404, 'AGENT_NOT_FOUND'],
    [409, 'PEER_HAS_NO_URL'],
  ])('never serves around a %s answer', async (status, code) => {
    await knownThenExpired();
    lookupReplies.set('analyst', { status, body: envelope(code) });

    const error = await agentUrl('analyst').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PeerLookupError);
    expect((error as PeerLookupError).status).toBe(status);
  });

  it('does not serve an address after the control plane said the peer is gone', async () => {
    await knownThenExpired();
    lookupReplies.set('analyst', {
      status: 404,
      body: envelope('AGENT_NOT_FOUND'),
    });
    await expect(agentUrl('analyst')).rejects.toBeInstanceOf(PeerNotFound);

    lookupReplies.set('analyst', unwell(503));
    const error = await agentUrl('analyst').catch((e: unknown) => e);

    expect((error as PeerLookupError).status).toBe(503); // nothing known to fall back to
  });

  it('throws the failure with no known address, and then waits it out without asking', async () => {
    lookupReplies.set('analyst', unwell(503));
    lookupRetryAfter = '7';

    const first = (await agentUrl('analyst').catch(
      (e: unknown) => e
    )) as PeerLookupError;
    expect(first.status).toBe(503);
    expect(first.retryAfter).toBe(7);

    clock.advance(2);
    const second = (await agentUrl('analyst').catch(
      (e: unknown) => e
    )) as PeerLookupError;

    expect(lookupCalls).toHaveLength(1); // the second did not ask
    expect(second.status).toBe(503);
    expect(second.retryAfter).toBeCloseTo(5);
    expect(second.message).toContain('no earlier address is known');
  });

  it('never answers fresh from memory', async () => {
    await knownThenExpired();
    lookupReplies.set('analyst', unwell(503));

    await expect(agentUrl('analyst', { fresh: true })).rejects.toBeInstanceOf(
      PeerLookupError
    );
    await expect(agentUrl('analyst', { fresh: true })).rejects.toBeInstanceOf(
      PeerLookupError
    ); // waiting is not an answer either

    expect(lookupCalls).toHaveLength(2); // the first fresh asked; the second waited
  });

  it('does not make one peer wait out another', async () => {
    lookupReplies.set('indexer', {
      status: 200,
      body: { name: 'indexer', url: INDEXER },
    });
    await knownThenExpired();
    lookupReplies.set('analyst', unwell(503));
    await agentUrl('analyst');

    await expect(agentUrl('indexer')).resolves.toBe(INDEXER);
  });

  it('falls back to the last list known, as a copy', async () => {
    lookupReplies.set(null, {
      status: 200,
      body: { peers: [{ name: 'analyst', url: OLD }] },
    });
    await expect(agentUrls()).resolves.toEqual({ analyst: OLD });
    clock.advance(WINDOW_PAST);
    lookupReplies.set(null, unwell(429));
    lookupRetryAfter = '9';

    const served = await agentUrls();
    served.analyst = 'edited';

    await expect(agentUrls()).resolves.toEqual({ analyst: OLD });
    expect(lookupCalls).toHaveLength(2); // the second read waited
    await expect(agentUrls({ fresh: true })).rejects.toBeInstanceOf(
      PeerLookupError
    );
  });

  it('throws a failed list when none is known', async () => {
    lookupReplies.set(null, unwell(503));

    const error = (await agentUrls().catch(
      (e: unknown) => e
    )) as PeerLookupError;

    expect(error.status).toBe(503);
  });

  it('does not let a failed list hold back a lookup by name', async () => {
    lookupReplies.set(null, unwell(503));
    await expect(agentUrls()).rejects.toBeInstanceOf(PeerLookupError);

    await expect(agentUrl('analyst')).resolves.toBe(OLD); // the two waits are separate
  });

  it('reaches the peer at the known address through an outage', async () => {
    behaviour.set(OLD, { status: 200, body: { ok: true } });
    await agentUrl('analyst');
    clock.advance(WINDOW_PAST);
    lookupReplies.set('analyst', unwell(429));
    lookupRetryAfter = '5';

    const response = await callAgent('analyst', '/x');

    expect(response.status).toBe(200);
    expect(peerCalls.map(c => c.url)).toEqual([`${OLD}/x`]);
  });

  it('does not retry, as a stale address, the one that just stopped answering', async () => {
    behaviour.set(OLD, UNREACHABLE);
    await agentUrl('analyst');
    lookupReplies.set('analyst', unwell(503));

    const error = (await callAgent('analyst', '/x').catch(
      (e: unknown) => e
    )) as PeerLookupError;

    expect(error).toBeInstanceOf(PeerLookupError);
    expect(error.status).toBe(503);
    expect(peerCalls.map(c => c.url)).toEqual([`${OLD}/x`]); // one request, to the address that was known
  });
});

// --- A LOOKUP THE CONTROL PLANE REFUSED BEFORE ANYTHING RAN ---------------------
//
// With a last known address the peer policy stands: it is served at once, and Retry-After is kept before asking
// again. With NOTHING known (the first lookup in this process, or a fresh one), a 503 RESOURCE_BUSY (nothing ran) is
// waited out once and asked again before the lookup fails; any other 429 or 5xx fails as it came. Every wait is
// recorded (`waiting.sleep`), never taken.

describe('a lookup the control plane answered 503 RESOURCE_BUSY', () => {
  let waits: number[];
  const busy: Reply = {
    status: 503,
    body: envelope('RESOURCE_BUSY'),
    headers: { 'Retry-After': '5' },
  };

  beforeEach(() => {
    waits = [];
    jest
      .spyOn(waiting, 'sleep')
      .mockImplementation(async (ms: number) => void waits.push(ms));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('with no known address, RESOURCE_BUSY is waited out once and asked again', async () => {
    lookupReplies.set('analyst', [
      busy,
      { status: 200, body: { name: 'analyst', url: OLD } },
    ]);
    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    expect([lookupCalls.length, waits]).toEqual([2, [5000]]);
  });

  it('with no known address, any other 503 fails as it came', async () => {
    lookupReplies.set('analyst', {
      status: 503,
      body: envelope('SERVICE_UNAVAILABLE'),
      headers: { 'Retry-After': '5' },
    });
    const error = await agentUrl('analyst').catch(e => e);
    expect(error).toBeInstanceOf(PeerLookupError);
    expect([lookupCalls.length, waits]).toEqual([1, []]);
  });

  it('with a known address, RESOURCE_BUSY serves it at once and waits for nothing', async () => {
    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    clock.advance(PEER_CACHE_SECONDS + 1);
    lookupReplies.set('analyst', busy);
    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    expect([lookupCalls.length, waits]).toEqual([2, []]);
  });

  it('a fresh lookup has nothing known to serve, so RESOURCE_BUSY is waited out once', async () => {
    await expect(agentUrl('analyst')).resolves.toBe(OLD);
    lookupReplies.set('analyst', [
      busy,
      { status: 200, body: { name: 'analyst', url: NEW } },
    ]);
    await expect(agentUrl('analyst', { fresh: true })).resolves.toBe(NEW);
    expect([lookupCalls.length, waits]).toEqual([3, [5000]]);
  });

  it('the list: with no known list, RESOURCE_BUSY is waited out once and asked again', async () => {
    lookupReplies.set(null, [
      busy,
      { status: 200, body: { peers: [{ name: 'analyst', url: OLD }] } },
    ]);
    await expect(agentUrls()).resolves.toEqual({ analyst: OLD });
    expect([lookupCalls.length, waits]).toEqual([2, [5000]]);
  });

  it('the list: with a known list, RESOURCE_BUSY serves it at once', async () => {
    lookupReplies.set(null, {
      status: 200,
      body: { peers: [{ name: 'analyst', url: OLD }] },
    });
    await agentUrls();
    clock.advance(PEER_CACHE_SECONDS + 1);
    lookupReplies.set(null, busy);
    await expect(agentUrls()).resolves.toEqual({ analyst: OLD });
    expect([lookupCalls.length, waits]).toEqual([2, []]);
  });
});
