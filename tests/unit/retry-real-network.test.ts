/**
 * A connection never made, on a real network: real Node sockets, no nock
 * interception, no server. Under real Node a connect that never completes is
 * reported by axios's own timeout (ECONNABORTED), the same code as a timeout
 * waiting for the answer; the SDK's agents watch the socket's `connect` to
 * tell them apart (HttpClient.watchingAgent, retry-policy.ts).
 */
import net from 'net';
import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { NetworkError } from '../../src/exceptions';
import { ONCE } from '../../src/retry-policy';
import { retryWithBackoff } from '../../src/utils';

type Counted = { request: jest.Mock };

function realClient(endpoint: string, timeout: number) {
  const client = new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    endpoint,
    workspace: 'w',
    timeout,
    enableConnectionPooling: false,
  });
  const http = (client as unknown as { httpClient: Counted }).httpClient;
  const real = http.request.bind(http);
  http.request = jest.fn(real);
  return { client, attempts: () => http.request.mock.calls.length };
}

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

// nock routes even allowed requests itself: take it out of http entirely.
beforeAll(() => {
  nock.restore();
  nock.enableNetConnect();
});
afterAll(() => {
  nock.activate();
  nock.disableNetConnect();
});

describe('a real connection never made is retried even for a ONCE operation', () => {
  it.each([
    // TEST-NET-1 (RFC 5737): never routed, so the connect never completes.
    ['a connect timeout (TEST-NET-1)', 'http://192.0.2.1'],
    // .invalid (RFC 2606) never resolves.
    ['a DNS failure', 'http://no-such-host.invalid'],
  ])('%s', async (_label, endpoint) => {
    const { client, attempts } = realClient(endpoint, 300);
    await expect(client.deleteCollection('docs')).rejects.toThrow(
      /Network error/
    );
    expect(attempts()).toBe(4); // deleteCollection is ONCE: only a never-sent retries
  });

  it('a refused connection', async () => {
    const port = await closedPort();
    const { client, attempts } = realClient(`http://127.0.0.1:${port}`, 3000);
    await expect(client.deleteCollection('docs')).rejects.toThrow(
      /Network error/
    );
    expect(attempts()).toBe(4);
  });
});

it('CONTROL: a connection that was made, then timed out, is not retried for a ONCE operation', async () => {
  // A server that accepts and never answers: the request was sent.
  const accepted: net.Socket[] = [];
  const server = net.createServer(socket => {
    accepted.push(socket);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    const { client, attempts } = realClient(`http://127.0.0.1:${port}`, 300);
    await expect(client.deleteCollection('docs')).rejects.toThrow(
      /Network error/
    );
    expect(attempts()).toBe(1);
  } finally {
    accepted.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('retryWithBackoff around a client call retries a never-made connection for a ONCE operation', async () => {
  const { client, attempts } = realClient('http://192.0.2.1', 300);

  const err = await retryWithBackoff(() => client.deleteCollection('docs'), {
    retryClass: ONCE,
    maxRetries: 1,
    baseDelay: 1,
  }).catch((e: unknown) => e);

  // The typed error carries the never-connected fact the client saw.
  expect(err).toBeInstanceOf(NetworkError);
  expect((err as NetworkError).requestSent).toBe(false);
  expect(attempts()).toBe(8); // the client's 4 attempts, twice
});
