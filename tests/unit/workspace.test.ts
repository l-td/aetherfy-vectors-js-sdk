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
    it('should prefix collection names with workspace on createCollection', async () => {
      process.env.AETHERFY_WORKSPACE = 'invoice-pipeline';

      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        workspace: 'auto',
        enableConnectionPooling: false,
      });

      const scope = nock(baseUrl)
        .post('/collections', body => {
          // Check that collection name is scoped
          return body.name === 'invoice-pipeline/documents';
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
        .get('/collections/invoice-pipeline%2Fdocuments')
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
          '/collections/invoice-pipeline%2Fdocuments/points/search',
          body => {
            return body.vector.length === 384;
          }
        )
        .reply(200, {
          result: [{ id: '1', score: 0.95, payload: { text: 'test' } }],
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

      // Mock getCollection for schema fetch
      nock(baseUrl)
        .get('/collections/invoice-pipeline%2Fdocuments')
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

      const upsertScope = nock(baseUrl)
        .put('/collections/invoice-pipeline%2Fdocuments/points', body => {
          return body.points.length === 1;
        })
        .reply(200, { success: true });

      const vector = new Array(384).fill(0.1);
      await client.upsert('documents', [
        { id: '1', vector, payload: { text: 'test' } },
      ]);

      expect(upsertScope.isDone()).toBe(true);
    });

    it('should not prefix collection names without workspace', async () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });

      const scope = nock(baseUrl)
        .post('/collections', body => {
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
    it('should filter and unscope collections in getCollections', async () => {
      process.env.AETHERFY_WORKSPACE = 'invoice-pipeline';

      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        workspace: 'auto',
        enableConnectionPooling: false,
      });

      nock(baseUrl)
        .get('/collections')
        .reply(200, {
          collections: [
            { name: 'invoice-pipeline/documents', config: {} },
            { name: 'invoice-pipeline/metadata', config: {} },
            { name: 'other-workspace/data', config: {} },
            { name: 'global-collection', config: {} },
          ],
        });

      const collections = await client.getCollections();

      // Should only return collections from our workspace, unscoped
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
        .get('/collections')
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

  describe('Workspace with schema operations', () => {
    it('should scope collection name in getSchema', async () => {
      process.env.AETHERFY_WORKSPACE = 'test-workspace';

      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        workspace: 'auto',
        enableConnectionPooling: false,
      });

      const scope = nock(baseUrl)
        .get('/schema/test-workspace%2Fdocuments')
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
        .put('/schema/test-workspace%2Fdocuments', body => {
          return body.schema && body.enforcement_mode === 'strict';
        })
        .reply(200, { etag: 'abc123' });

      await client.setSchema('documents', { fields: {} }, 'strict');

      expect(scope.isDone()).toBe(true);
    });
  });
});
