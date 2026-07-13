/**
 * Unit tests for Workspace functionality
 */

import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { DistanceMetric } from '../../src/models';

describe('Workspace Support', () => {
  const baseUrl = 'https://vectors.aetherfy.com';

  afterEach(() => {
    nock.cleanAll();
    delete process.env.AETHERFY_WORKSPACE;
  });

  describe('Constructor workspace detection', () => {
    it('should detect workspace from environment when workspace="auto"', () => {
      process.env.AETHERFY_WORKSPACE = 'test-workspace';

      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        workspace: 'auto',
        enableConnectionPooling: false,
      });

      expect(client).toBeInstanceOf(AetherfyVectorsClient);
    });

    it('should use explicit workspace when provided', () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        workspace: 'explicit-workspace',
        enableConnectionPooling: false,
      });

      expect(client).toBeInstanceOf(AetherfyVectorsClient);
    });

    it('should work without workspace (backward compatibility)', () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });

      expect(client).toBeInstanceOf(AetherfyVectorsClient);
    });
  });

  describe('Collection scoping with workspace', () => {
    it('should POST to nested URL with bare body name on createCollection', async () => {
      // Post-A/B: workspace lives in URL path, body name is bare.
      // vectordb rejects body name containing "/".
      process.env.AETHERFY_WORKSPACE = 'invoice-pipeline';

      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        workspace: 'auto',
        enableConnectionPooling: false,
      });

      const scope = nock(baseUrl)
        .post('/api/v1/workspaces/invoice-pipeline/collections', body => {
          return body.name === 'documents' && !body.name.includes('/');
        })
        .reply(201, { success: true });

      await client.createCollection('documents', {
        size: 384,
        distance: DistanceMetric.COSINE,
      });

      expect(scope.isDone()).toBe(true);
    });

    it('should prefix collection names with workspace on search', async () => {
      process.env.AETHERFY_WORKSPACE = 'invoice-pipeline';

      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        workspace: 'auto',
        enableConnectionPooling: false,
      });

      // Mock getCollection for schema fetch
      nock(baseUrl)
        .get('/api/v1/workspaces/invoice-pipeline/collections/documents')
        .reply(200, {
          result: {
            name: 'invoice-pipeline/documents',
            config: {
              params: {
                vectors: {
                  size: 384,
                  distance: 'Cosine',
                },
              },
            },
          },
          schema_version: 'v1',
        });

      const searchScope = nock(baseUrl)
        .post(
          '/api/v1/workspaces/invoice-pipeline/collections/documents/points/search',
          body => {
            return body.vector.length === 384;
          }
        )
        .reply(200, {
          result: [{ id: 1, score: 0.95, payload: { text: 'test' } }],
        });

      const queryVector = new Array(384).fill(0.1);
      const results = await client.search('documents', queryVector);

      expect(results).toHaveLength(1);
      expect(searchScope.isDone()).toBe(true);
    });

    it('should prefix collection names with workspace on upsert', async () => {
      process.env.AETHERFY_WORKSPACE = 'invoice-pipeline';

      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        workspace: 'auto',
        enableConnectionPooling: false,
      });

      // Mock getCollection for vector schema fetch
      nock(baseUrl)
        .get('/api/v1/workspaces/invoice-pipeline/collections/documents')
        .reply(200, {
          result: {
            name: 'invoice-pipeline/documents',
            config: {
              params: {
                vectors: {
                  size: 384,
                  distance: 'Cosine',
                },
              },
            },
          },
          schema_version: 'v1',
        });

      // Mock getSchema for payload schema fetch (returns 404 = no schema)
      nock(baseUrl)
        .get('/api/v1/schema/invoice-pipeline%2Fdocuments')
        .reply(404, {
          error: { code: 'SCHEMA_NOT_FOUND', message: 'No schema' },
        });

      const upsertScope = nock(baseUrl)
        .put(
          '/api/v1/workspaces/invoice-pipeline/collections/documents/points',
          body => {
            return body.points.length === 1;
          }
        )
        .reply(200, { success: true });

      const vector = new Array(384).fill(0.1);
      await client.upsert('documents', [
        { id: 1, vector, payload: { text: 'test' } },
      ]);

      expect(upsertScope.isDone()).toBe(true);
    });

    it('should not prefix collection names without workspace', async () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });

      const scope = nock(baseUrl)
        .post('/api/v1/collections', body => {
          // Check that collection name is NOT scoped
          return body.name === 'documents';
        })
        .reply(201, { success: true });

      await client.createCollection('documents', {
        size: 384,
        distance: DistanceMetric.COSINE,
      });

      expect(scope.isDone()).toBe(true);
    });
  });

  describe('Collection listing with workspace', () => {
    it('should GET nested list URL and return server-filtered bare-named collections', async () => {
      // Post-A/B: GET /workspaces/{ws}/collections returns ONLY this
      // workspace's collections (server-side filter by workspace_id),
      // with bare names. The SDK no longer filters or unscopes client-
      // side — pinning that contract here.
      process.env.AETHERFY_WORKSPACE = 'invoice-pipeline';

      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        workspace: 'auto',
        enableConnectionPooling: false,
      });

      nock(baseUrl)
        .get('/api/v1/workspaces/invoice-pipeline/collections')
        .reply(200, {
          collections: [
            { name: 'documents', config: {} },
            { name: 'metadata', config: {} },
          ],
        });

      const collections = await client.getCollections();

      expect(collections).toHaveLength(2);
      expect(collections[0].name).toBe('documents');
      expect(collections[1].name).toBe('metadata');
    });

    it('should return all collections without workspace', async () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });

      nock(baseUrl)
        .get('/api/v1/collections')
        .reply(200, {
          collections: [
            { name: 'collection1', config: {} },
            { name: 'collection2', config: {} },
          ],
        });

      const collections = await client.getCollections();

      expect(collections).toHaveLength(2);
      expect(collections[0].name).toBe('collection1');
      expect(collections[1].name).toBe('collection2');
    });
  });

  describe('getCollection with workspace', () => {
    it('should GET nested URL and return bare-named collection from vectordb', async () => {
      // Post-A/B: vectordb returns the bare collection name (PG stores
      // name without workspace prefix). The SDK no longer needs to
      // unscope client-side.
      process.env.AETHERFY_WORKSPACE = 'invoice-pipeline';

      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        workspace: 'auto',
        enableConnectionPooling: false,
      });

      nock(baseUrl)
        .get('/api/v1/workspaces/invoice-pipeline/collections/documents')
        .reply(200, {
          result: {
            name: 'documents',
            config: {},
          },
        });

      const collection = await client.getCollection('documents');

      expect(collection.name).toBe('documents');
    });
  });

  describe('Workspace with schema operations', () => {
    it('should scope collection name in getSchema', async () => {
      process.env.AETHERFY_WORKSPACE = 'test-workspace';

      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        workspace: 'auto',
        enableConnectionPooling: false,
      });

      const scope = nock(baseUrl)
        .get('/api/v1/schema/test-workspace%2Fdocuments')
        .reply(200, {
          schema: { fields: {} },
          enforcement_mode: 'off',
          etag: 'abc123',
        });

      await client.getSchema('documents');

      expect(scope.isDone()).toBe(true);
    });

    it('should scope collection name in setSchema', async () => {
      process.env.AETHERFY_WORKSPACE = 'test-workspace';

      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        workspace: 'auto',
        enableConnectionPooling: false,
      });

      const scope = nock(baseUrl)
        .put('/api/v1/schema/test-workspace%2Fdocuments', body => {
          return body.schema && body.enforcement_mode === 'strict';
        })
        .reply(200, { etag: 'abc123' });

      await client.setSchema('documents', { fields: {} }, 'strict');

      expect(scope.isDone()).toBe(true);
    });
  });
});
