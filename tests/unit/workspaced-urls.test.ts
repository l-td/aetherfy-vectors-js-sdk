/**
 * Workspaced URL contract tests for AetherfyVectorsClient.
 *
 * Every collection lives in a workspace, so every collection-scoped HTTP
 * call uses one of two nested forms, with a bare collection name:
 * `/api/v1/workspaces/{name}/collections/{coll}[/<suffix>]` for a name, and
 * `/api/v1/workspace-ids/{id}/collections/{coll}[/<suffix>]` for
 * workspace: 'auto'. There is no bare `/collections` form: vectordb
 * answers it with 400 WORKSPACE_REQUIRED.
 *
 * Tests use nock to assert exact URL paths.
 */
import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { DistanceMetric } from '../../src/models';

describe('AetherfyVectorsClient — workspaced URL contract', () => {
  let client: AetherfyVectorsClient;
  const WS = 'my-workspace';
  const COLL = 'my-coll';

  beforeEach(() => {
    nock.cleanAll();
    client = new AetherfyVectorsClient({
      apiKey: 'afy_test_1234567890123456',
      endpoint: 'https://vectors.aetherfy.com',
      workspace: WS,
      enableConnectionPooling: false,
    });
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('createCollection', () => {
    it('POSTs to nested URL with bare name in body', async () => {
      const scope = nock('https://vectors.aetherfy.com')
        .post(`/api/v1/workspaces/${WS}/collections`, body => {
          // Body name MUST be bare — vectordb rejects "ws/coll" with 400
          // INVALID_COLLECTION_NAME.
          return body.name === COLL && !body.name.includes('/');
        })
        .reply(201, { success: true });

      await client.createCollection(COLL, {
        size: 128,
        distance: DistanceMetric.COSINE,
      });
      expect(scope.isDone()).toBe(true);
    });

    it('does NOT POST to flat /collections when workspace is set', async () => {
      // If the wire URL accidentally regressed to the flat form,
      // this nock interceptor would catch it as "no match" → request
      // throws. We also explicitly nock the correct path to keep the
      // happy path alive.
      const wrongPath = nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections')
        .reply(500, {}); // would only fire if regressed
      const correctPath = nock('https://vectors.aetherfy.com')
        .post(`/api/v1/workspaces/${WS}/collections`)
        .reply(201, {});

      await client.createCollection(COLL, {
        size: 128,
        distance: DistanceMetric.COSINE,
      });
      expect(correctPath.isDone()).toBe(true);
      expect(wrongPath.isDone()).toBe(false);
    });
  });

  describe('getCollections (list)', () => {
    it('GETs the nested list URL', async () => {
      const scope = nock('https://vectors.aetherfy.com')
        .get(`/api/v1/workspaces/${WS}/collections`)
        .reply(200, {
          collections: [
            { name: COLL, config: { size: 128, distance: 'Cosine' } },
          ],
        });

      const collections = await client.getCollections();
      expect(scope.isDone()).toBe(true);
      // vectordb returns bare names in nested-list responses; no
      // client-side unscoping needed.
      expect(collections[0].name).toBe(COLL);
    });
  });

  describe('deleteCollection', () => {
    it('DELETEs the nested collection URL', async () => {
      const scope = nock('https://vectors.aetherfy.com')
        .delete(`/api/v1/workspaces/${WS}/collections/${COLL}`)
        .reply(200, {});

      await client.deleteCollection(COLL);
      expect(scope.isDone()).toBe(true);
    });
  });

  describe('getCollection', () => {
    it('GETs the nested collection URL', async () => {
      const scope = nock('https://vectors.aetherfy.com')
        .get(`/api/v1/workspaces/${WS}/collections/${COLL}`)
        .reply(200, {
          result: {
            name: COLL,
            config: { params: { vectors: { size: 128, distance: 'Cosine' } } },
          },
          schema_version: 'abc12345',
        });

      const info = await client.getCollection(COLL);
      expect(scope.isDone()).toBe(true);
      expect(info.name).toBe(COLL);
    });
  });

  describe('collectionExists', () => {
    it('GETs the nested URL for existence check', async () => {
      // Need a fresh client whose schema cache is empty for this collection
      // — otherwise the fast path returns true without an HTTP call.
      const freshClient = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        endpoint: 'https://vectors.aetherfy.com',
        workspace: WS,
        enableConnectionPooling: false,
      });
      const scope = nock('https://vectors.aetherfy.com')
        .get(`/api/v1/workspaces/${WS}/collections/${COLL}`)
        .reply(200, {});

      const exists = await freshClient.collectionExists(COLL);
      expect(exists).toBe(true);
      expect(scope.isDone()).toBe(true);
    });
  });

  describe('point operations', () => {
    // Each pins the {suffix} part of the nested URL — exhaustive
    // coverage of the buildCollectionPath(coll, '/points/...') helper.

    const PATHS: Array<{
      name: string;
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      suffix: string;
      trigger: (c: AetherfyVectorsClient) => Promise<unknown>;
    }> = [
      {
        name: 'search → /points/query',
        method: 'POST',
        suffix: '/points/query',
        trigger: c => c.search(COLL, new Array(128).fill(0.1), { limit: 1 }),
      },
      {
        name: 'scroll → /points/scroll',
        method: 'POST',
        suffix: '/points/scroll',
        trigger: c => c.scroll(COLL, { limit: 1 }),
      },
      {
        name: 'count → /points/count',
        method: 'POST',
        suffix: '/points/count',
        trigger: c => c.count(COLL),
      },
      {
        name: 'retrieve → /points/retrieve',
        method: 'POST',
        suffix: '/points/retrieve',
        trigger: c =>
          c.retrieve(COLL, ['11111111-1111-1111-1111-111111111111']),
      },
      {
        name: 'delete points → /points/delete',
        method: 'POST',
        suffix: '/points/delete',
        trigger: c => c.delete(COLL, ['11111111-1111-1111-1111-111111111111']),
      },
    ];

    for (const p of PATHS) {
      it(`${p.name} uses nested URL`, async () => {
        const scope = nock('https://vectors.aetherfy.com')
          .intercept(
            `/api/v1/workspaces/${WS}/collections/${COLL}${p.suffix}`,
            p.method
          )
          .reply(200, {
            result: [],
            status: 'ok',
            schema_version: 'abc12345',
            points_count: 0,
          });

        await p.trigger(client).catch(() => {
          // Some endpoints validate response shape further; we only care
          // about the URL match here. Suppress downstream parse errors.
        });
        expect(scope.isDone()).toBe(true);
      });
    }
  });

  describe("workspace: 'auto' (the agent's workspace, by id)", () => {
    it('uses /workspace-ids/{id}/collections', async () => {
      const id = '0f8e2b9a-7c41-4d2e-9b3a-5e6f7a8b9c0d';
      process.env.AETHERFY_WORKSPACE_ID = id;
      const idClient = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        endpoint: 'https://vectors.aetherfy.com',
        enableConnectionPooling: false,
      });

      const scope = nock('https://vectors.aetherfy.com')
        .post(
          `/api/v1/workspace-ids/${id}/collections`,
          body => body.name === COLL
        )
        .reply(201, {});

      await idClient.createCollection(COLL, {
        size: 128,
        distance: DistanceMetric.COSINE,
      });
      expect(scope.isDone()).toBe(true);
    });
  });
});
