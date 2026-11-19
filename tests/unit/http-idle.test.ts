/**
 * THE SDK CLOSES AN IDLE CONNECTION LONG BEFORE THE SERVICE'S EDGE WOULD.
 *
 * A pooled connection that sits unused is closed by the SDK after IDLE_SOCKET_MS. The service's edge closes a client
 * connection that has been idle for 400 s (not configurable), so while the SDK's figure is far below it the SDK is the
 * side that closes: it never reuses a socket the edge has already closed, which would fail as a connection reset that
 * the retry rules do not repeat for the operations that cannot safely be repeated (the ONCE class of retry-policy.ts).
 *
 * The edge's figure is not in this repository; it is the one number these tests check the SDK's against, and the
 * control plane's REVIEW_FAQ (section 113) cites where it is published. The agents' real options are read, so a constant
 * that is changed but no longer reaches the agents is caught too.
 */
import http from 'http';
import https from 'https';
import { HttpClient, IDLE_SOCKET_MS } from '../../src/http/client';

// What the service's edge does with a client connection that sits idle, in ms.
const EDGE_CLIENT_IDLE_MS = 400_000;

type PooledAgents = {
  httpAgent: http.Agent & {
    options: { keepAlive?: boolean; timeout?: number };
  };
  httpsAgent: https.Agent & {
    options: { keepAlive?: boolean; timeout?: number };
  };
};

function agentsOf(client: HttpClient): PooledAgents {
  return client as unknown as PooledAgents;
}

describe('an idle pooled connection', () => {
  it('is closed by the SDK after 60 seconds', () => {
    expect(IDLE_SOCKET_MS).toBe(60_000);
  });

  it('is the figure both pooled agents are built with', () => {
    const client = new HttpClient({ enableConnectionPooling: true });
    try {
      const { httpAgent, httpsAgent } = agentsOf(client);
      expect(httpAgent.options.keepAlive).toBe(true);
      expect(httpsAgent.options.keepAlive).toBe(true);
      expect(httpAgent.options.timeout).toBe(IDLE_SOCKET_MS);
      expect(httpsAgent.options.timeout).toBe(IDLE_SOCKET_MS);
    } finally {
      client.destroy();
    }
  });

  it("is far below the edge's: the SDK closes first, never the edge", () => {
    expect(IDLE_SOCKET_MS * 2).toBeLessThanOrEqual(EDGE_CLIENT_IDLE_MS);
  });

  it('keeps nothing idle when pooling is off', () => {
    const client = new HttpClient({ enableConnectionPooling: false });
    try {
      const { httpAgent, httpsAgent } = agentsOf(client);
      expect(httpAgent.options.keepAlive).toBe(false);
      expect(httpsAgent.options.keepAlive).toBe(false);
      expect(httpAgent.options.timeout).toBeUndefined();
    } finally {
      client.destroy();
    }
  });
});
