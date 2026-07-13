/**
 * Unit tests for AetherfyVectorsClient
 */

import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { DistanceMetric, VectorConfig, Point } from '../../src/models';
import {
  ValidationError,
  NetworkError,
  AetherfyVectorsError,
  CollectionInUseError,
  SchemaNotFoundError,
  SchemaValidationError,
} from '../../src/exceptions';
import { HttpClient } from '../../src/http/client';

describe('AetherfyVectorsClient', () => {
  describe('Constructor', () => {
    it('should create client with explicit API key', () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });
      expect(client).toBeInstanceOf(AetherfyVectorsClient);
    });

    it('should throw error with invalid API key', () => {
      expect(() => {
        new AetherfyVectorsClient({
          apiKey: 'invalid_key',
          enableConnectionPooling: false,
        });
      }).toThrow("Invalid API key format. API key must start with 'afy_'");
    });

    it('should use custom endpoint when provided', () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        endpoint: 'https://custom.endpoint.com',
        enableConnectionPooling: false,
      });
      expect(client).toBeInstanceOf(AetherfyVectorsClient);
      expect((client as unknown as { endpoint: string }).endpoint).toBe(
        'https://custom.endpoint.com'
      );
    });

    it('should use AETHERFY_VECTORS_URL env var when no endpoint provided', () => {
      // Set by control-plane on Fly machines so deployed agents reach the
      // regional backend privately over the WireGuard tunnel.
      process.env.AETHERFY_VECTORS_URL = 'http://10.0.10.243:3000';
      try {
        const client = new AetherfyVectorsClient({
          apiKey: 'afy_test_1234567890123456',
          enableConnectionPooling: false,
        });
        expect((client as unknown as { endpoint: string }).endpoint).toBe(
          'http://10.0.10.243:3000'
        );
      } finally {
        delete process.env.AETHERFY_VECTORS_URL;
      }
    });

    it('should prefer explicit endpoint over AETHERFY_VECTORS_URL env var', () => {
      process.env.AETHERFY_VECTORS_URL = 'http://10.0.10.243:3000';
      try {
        const client = new AetherfyVectorsClient({
          apiKey: 'afy_test_1234567890123456',
          endpoint: 'https://override.example.com',
          enableConnectionPooling: false,
        });
        expect((client as unknown as { endpoint: string }).endpoint).toBe(
          'https://override.example.com'
        );
      } finally {
        delete process.env.AETHERFY_VECTORS_URL;
      }
    });

    it('should fall back to default endpoint when neither is set', () => {
      delete process.env.AETHERFY_VECTORS_URL;
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });
      expect((client as unknown as { endpoint: string }).endpoint).toBe(
        'https://vectors.aetherfy.com'
      );
    });
  });

  describe('Collection Management', () => {
    let client: AetherfyVectorsClient;

    beforeEach(() => {
      client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });
    });

    it('should create collection successfully', async () => {
      const scope = nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections', body => body.name === 'test-collection')
        .reply(201, { success: true });

      const result = await client.createCollection('test-collection', {
        size: 128,
        distance: DistanceMetric.COSINE,
      });

      // createCollection now returns the created Collection (not boolean).
      expect(result.name).toBe('test-collection');
      expect(result.config.size).toBe(128);
      expect(result.config.distance).toBe(DistanceMetric.COSINE);
      expect(scope.isDone()).toBe(true);
    });

    it('should create collection with description', async () => {
      const scope = nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections', body => {
          return (
            body.name === 'test-collection' &&
            body.description === 'Test collection for embeddings'
          );
        })
        .reply(201, { success: true });

      const result = await client.createCollection(
        'test-collection',
        {
          size: 128,
          distance: DistanceMetric.COSINE,
        },
        'Test collection for embeddings'
      );

      expect(result.name).toBe('test-collection');
      expect(result.description).toBe('Test collection for embeddings');
      expect(scope.isDone()).toBe(true);
    });

    it('should create collection without description sends null', async () => {
      const scope = nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections', body => {
          return body.name === 'test-collection' && body.description === null;
        })
        .reply(201, { success: true });

      const result = await client.createCollection('test-collection', {
        size: 128,
        distance: DistanceMetric.COSINE,
      });

      expect(result.name).toBe('test-collection');
      expect(scope.isDone()).toBe(true);
    });

    it('createCollection omits regions from POST body and echoes server-resolved regions', async () => {
      // §66: when the caller omits `regions`, the SDK must NOT send a
      // `regions` key (server resolves to the full scope). The returned
      // Collection.regions reflects whatever the server echoes back.
      const scope = nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections', body => {
          return body.name === 'no-regions' && !('regions' in body);
        })
        .reply(201, {
          regions: ['us-east-1', 'eu-central-1', 'ap-southeast-1'],
        });

      const result = await client.createCollection('no-regions', {
        size: 128,
        distance: DistanceMetric.COSINE,
      });

      expect(result.name).toBe('no-regions');
      expect(result.regions).toEqual([
        'us-east-1',
        'eu-central-1',
        'ap-southeast-1',
      ]);
      expect(scope.isDone()).toBe(true);
    });

    it('createCollection forwards an explicit regions subset and echoes it back', async () => {
      // §66: an explicit subset is forwarded verbatim; the server echoes
      // the pinned list, which the returned Collection surfaces.
      const scope = nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections', body => {
          return (
            body.name === 'subset-regions' &&
            JSON.stringify(body.regions) === JSON.stringify(['us-east-1'])
          );
        })
        .reply(201, { regions: ['us-east-1'] });

      const result = await client.createCollection(
        'subset-regions',
        { size: 128, distance: DistanceMetric.COSINE },
        undefined,
        ['us-east-1']
      );

      expect(result.regions).toEqual(['us-east-1']);
      expect(scope.isDone()).toBe(true);
    });

    it('createCollection forwards an explicit empty regions array (server rejects, SDK does not)', async () => {
      // §66: an explicit [] IS forwarded so the server can return 422
      // COLLECTION_REGIONS_EMPTY — the SDK never silently treats [] as
      // "all regions". Response body may omit regions.
      const scope = nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections', body => {
          return (
            body.name === 'empty-regions' &&
            Array.isArray(body.regions) &&
            body.regions.length === 0
          );
        })
        .reply(201, { success: true });

      const result = await client.createCollection(
        'empty-regions',
        { size: 128, distance: DistanceMetric.COSINE },
        undefined,
        []
      );

      expect(result.name).toBe('empty-regions');
      expect(result.regions).toBeUndefined();
      expect(scope.isDone()).toBe(true);
    });

    it('should validate collection name', async () => {
      await expect(
        client.createCollection('', {
          size: 128,
          distance: DistanceMetric.COSINE,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.createCollection('invalid name with spaces!', {
          size: 128,
          distance: DistanceMetric.COSINE,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('should list collections', async () => {
      const mockCollections = [
        { name: 'collection1', config: { size: 128, distance: 'Cosine' } },
        { name: 'collection2', config: { size: 256, distance: 'Euclidean' } },
      ];

      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections')
        .reply(200, { collections: mockCollections });

      const collections = await client.getCollections();

      expect(collections).toEqual(mockCollections);
    });

    it('should check if collection exists', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/test-collection')
        .reply(200, { name: 'test-collection' });

      const exists = await client.collectionExists('test-collection');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent collection', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/non-existent')
        .reply(404, { message: 'Collection not found' });

      const exists = await client.collectionExists('non-existent');
      expect(exists).toBe(false);
    });

    it('should delete collection', async () => {
      nock('https://vectors.aetherfy.com')
        .delete('/api/v1/collections/test-collection')
        .reply(204);

      const result = await client.deleteCollection('test-collection');
      expect(result).toBe(true);
    });

    it('createCollection prepopulates schemaCache from request body', async () => {
      // Closes the create→read consistency window: backend's
      // GET /collections/<name> hits Qdrant, which is eventually
      // consistent w.r.t. its own writes, so a read immediately after
      // a 2xx create can briefly return 4xx. Cache prepopulation
      // routes the next collectionExists/upsert through local state.
      nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections')
        .reply(201, { success: true });

      await client.createCollection('fresh-coll', {
        size: 384,
        distance: DistanceMetric.COSINE,
      });

      // collectionExists must succeed *without* any GET being mocked.
      // node-setup disables net connect, so an unmocked GET would throw
      // — this is the load-bearing assertion: cache covered the call.
      const exists = await client.collectionExists('fresh-coll');
      expect(exists).toBe(true);
    });

    it('deleteCollection clears the schemaCache (subsequent exists hits the network)', async () => {
      // Seed the cache via create...
      nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections')
        .reply(201, { success: true });
      await client.createCollection('doomed', {
        size: 128,
        distance: DistanceMetric.COSINE,
      });

      // ...then delete. Cache must be dropped so a fresh exists check
      // actually hits the wire (otherwise a recreate-with-different-shape
      // would silently use stale size/distance/etag).
      nock('https://vectors.aetherfy.com')
        .delete('/api/v1/collections/doomed')
        .reply(204);
      await client.deleteCollection('doomed');

      // Now collectionExists *must* make the GET. We mock it to return
      // 404 so the call is observable AND the result is correct.
      const scope = nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/doomed')
        .reply(404, { message: 'Collection not found' });
      const exists = await client.collectionExists('doomed');

      expect(exists).toBe(false);
      expect(scope.isDone()).toBe(true);
    });

    it('collectionExists fast-path returns true with no HTTP when cached', async () => {
      // Direct cache seed — isolates the fast path from create_collection.
      // node-setup's disableNetConnect ensures any HTTP attempt would throw.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).schemaCache.set('already-known', {
        size: 128,
        distance: 'Cosine',
      });

      const exists = await client.collectionExists('already-known');
      expect(exists).toBe(true);
    });

    it('upsert 404 evicts both caches (self-healing after cross-client delete)', async () => {
      // Pre-seed both caches as if a prior create/upsert had populated them.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = client as any;
      c.schemaCache.set('ghost', { size: 4, distance: 'Cosine' });
      c.payloadSchemaCache.set('ghost', {
        schema: null,
        enforcementMode: 'off',
        etag: null,
        description: null,
      });

      // The PUT /points returns 404 — the collection is gone upstream
      // (e.g. cross-client delete). The SDK must drop the local caches
      // so subsequent calls go back to the network.
      nock('https://vectors.aetherfy.com')
        .put('/api/v1/collections/ghost/points')
        .reply(404, { message: 'Collection not found' });

      await expect(
        client.upsert('ghost', [{ id: 1, vector: [0.1, 0.2, 0.3, 0.4] }])
      ).rejects.toThrow();

      expect(c.schemaCache.has('ghost')).toBe(false);
      expect(c.payloadSchemaCache.has('ghost')).toBe(false);
    });

    it('getCollection 404 evicts both caches', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = client as any;
      c.schemaCache.set('ghost', { size: 128, distance: 'Cosine' });
      c.payloadSchemaCache.set('ghost', {
        schema: null,
        enforcementMode: 'off',
        etag: null,
        description: null,
      });

      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/ghost')
        .reply(404, { message: 'Collection not found' });

      await expect(client.getCollection('ghost')).rejects.toThrow();

      expect(c.schemaCache.has('ghost')).toBe(false);
      expect(c.payloadSchemaCache.has('ghost')).toBe(false);
    });

    it('non-404 errors do NOT evict caches (transient failures preserve cache)', async () => {
      // 503 is transient — the collection is still upstream. Wiping the
      // cache here would force a needless round trip on the next call.
      // The SDK retries 503 (executeWithRetry, maxRetries=3 + exponential
      // backoff) so the mock must cover initial + 3 retry attempts; fake
      // timers fast-forward the backoff waits to keep the test under the
      // jest default timeout. Same pattern as `should handle createCollection
      // errors` above.
      jest.useFakeTimers();

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = client as any;
        c.schemaCache.set('intact', { size: 4, distance: 'Cosine' });

        nock('https://vectors.aetherfy.com')
          .put('/api/v1/collections/intact/points')
          .times(4)
          .reply(503, { message: 'Service Unavailable' });

        const expectation = expect(
          client.upsert('intact', [{ id: 1, vector: [0.1, 0.2, 0.3, 0.4] }])
        ).rejects.toThrow();
        await jest.runAllTimersAsync();
        await expectation;

        // Cache survives the transient error.
        expect(c.schemaCache.has('intact')).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should get collection information', async () => {
      const mockCollection = {
        name: 'test-collection',
        config: { size: 128, distance: 'Cosine' },
        pointsCount: 1000,
      };

      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/test-collection')
        .reply(200, { result: mockCollection });

      const collection = await client.getCollection('test-collection');

      expect(collection).toEqual(mockCollection);
    });

    it('should validate collection name length', async () => {
      await expect(
        client.createCollection('a'.repeat(256), {
          size: 128,
          distance: DistanceMetric.COSINE,
        })
      ).rejects.toThrow('Collection name must be between 1 and 255 characters');
    });

    it('should validate vector config is an object', async () => {
      await expect(
        client.createCollection('test', null as unknown as VectorConfig)
      ).rejects.toThrow('Vector configuration must be an object');
    });

    it('should validate vector size is positive', async () => {
      await expect(
        client.createCollection('test', {
          size: 0,
          distance: DistanceMetric.COSINE,
        })
      ).rejects.toThrow('Vector size must be a positive number');

      await expect(
        client.createCollection('test', {
          size: -10,
          distance: DistanceMetric.COSINE,
        })
      ).rejects.toThrow('Vector size must be a positive number');
    });

    it('should validate distance metric is specified', async () => {
      await expect(
        client.createCollection('test', {
          size: 128,
          distance: '' as unknown as DistanceMetric,
        })
      ).rejects.toThrow('Distance metric must be specified');

      await expect(
        client.createCollection('test', {
          size: 128,
        } as unknown as VectorConfig)
      ).rejects.toThrow('Distance metric must be specified');
    });

    it('should accept distance metric as lowercase string "cosine"', async () => {
      const scope = nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections', body => {
          return body.name === 'test' && body.vectors.distance === 'Cosine';
        })
        .reply(201, { success: true });

      await client.createCollection('test', {
        size: 128,
        distance: 'cosine' as any,
      });

      expect(scope.isDone()).toBe(true);
    });

    it('should accept distance metric as lowercase string "euclidean"', async () => {
      const scope = nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections', body => {
          return body.name === 'test' && body.vectors.distance === 'Euclidean';
        })
        .reply(201, { success: true });

      await client.createCollection('test', {
        size: 128,
        distance: 'euclidean' as any,
      });

      expect(scope.isDone()).toBe(true);
    });

    it('should accept distance metric as lowercase string "euclid" (alias)', async () => {
      const scope = nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections', body => {
          return body.name === 'test' && body.vectors.distance === 'Euclidean';
        })
        .reply(201, { success: true });

      await client.createCollection('test', {
        size: 128,
        distance: 'euclid' as any,
      });

      expect(scope.isDone()).toBe(true);
    });

    it('should accept distance metric as lowercase string "dot"', async () => {
      const scope = nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections', body => {
          return body.name === 'test' && body.vectors.distance === 'Dot';
        })
        .reply(201, { success: true });

      await client.createCollection('test', {
        size: 128,
        distance: 'dot' as any,
      });

      expect(scope.isDone()).toBe(true);
    });

    it('should accept distance metric as lowercase string "manhattan"', async () => {
      const scope = nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections', body => {
          return body.name === 'test' && body.vectors.distance === 'Manhattan';
        })
        .reply(201, { success: true });

      await client.createCollection('test', {
        size: 128,
        distance: 'manhattan' as any,
      });

      expect(scope.isDone()).toBe(true);
    });

    it('should accept distance metric as exact enum string "Cosine"', async () => {
      const scope = nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections', body => {
          return body.name === 'test' && body.vectors.distance === 'Cosine';
        })
        .reply(201, { success: true });

      await client.createCollection('test', {
        size: 128,
        distance: 'Cosine' as any,
      });

      expect(scope.isDone()).toBe(true);
    });

    it('should reject invalid distance metric string', async () => {
      await expect(
        client.createCollection('test', {
          size: 128,
          distance: 'invalid-metric' as any,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.createCollection('test', {
          size: 128,
          distance: 'invalid-metric' as any,
        })
      ).rejects.toThrow('Invalid distance metric');
    });

    it('should reject non-string non-enum distance metric', async () => {
      await expect(
        client.createCollection('test', {
          size: 128,
          distance: 123 as any,
        })
      ).rejects.toThrow(ValidationError);

      await expect(
        client.createCollection('test', {
          size: 128,
          distance: 123 as any,
        })
      ).rejects.toThrow(
        'Distance metric must be a DistanceMetric enum or valid string'
      );
    });
  });

  describe('Vector Operations', () => {
    let client: AetherfyVectorsClient;

    beforeEach(() => {
      client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });
    });

    it('should upsert points successfully', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: {
                  size: 3,
                  distance: 'Cosine',
                },
              },
            },
          },
          schema_version: 'v1',
        });

      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(404, {});

      nock('https://vectors.aetherfy.com')
        .put('/api/v1/collections/test-collection/points')
        .reply(200, { success: true });

      const points = [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3],
          payload: { category: 'test' },
        },
      ];

      const result = await client.upsert('test-collection', points);
      expect(result).toBe(true);
    });

    it('should validate point data', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: {
                  size: 3,
                  distance: 'Cosine',
                },
              },
            },
          },
          schema_version: 'v1',
        });

      const invalidPoints = [
        {
          // Missing ID
          vector: [0.1, 0.2, 0.3],
          payload: { category: 'test' },
        },
      ];

      await expect(
        client.upsert('test-collection', invalidPoints)
      ).rejects.toThrow(ValidationError);

      // No need to mock GET again - schema is cached from first call
      const invalidVector = [
        {
          id: 1,
          vector: [0.1, 'invalid', 0.3], // Invalid vector component
          payload: { category: 'test' },
        },
      ];

      await expect(
        client.upsert('test-collection', invalidVector)
      ).rejects.toThrow(ValidationError);
    });

    it('should search vectors', async () => {
      const mockResults = [
        {
          id: 1,
          score: 0.95,
          payload: { category: 'test' },
        },
      ];

      nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections/test-collection/points/search')
        .reply(200, { result: mockResults });

      const queryVector = [0.1, 0.2, 0.3];
      const results = await client.search('test-collection', queryVector, {
        limit: 5,
        withPayload: true,
      });

      expect(results).toEqual(mockResults);
    });

    it('should validate search vector', async () => {
      const invalidVector = [0.1, NaN, 0.3];

      await expect(
        client.search('test-collection', invalidVector)
      ).rejects.toThrow(ValidationError);
    });

    it('should validate vector is an array', async () => {
      await expect(
        client.search('test-collection', 'not-an-array' as unknown as number[])
      ).rejects.toThrow('Vector must be an array of numbers');
    });

    it('should validate vector is not empty', async () => {
      await expect(client.search('test-collection', [])).rejects.toThrow(
        'Vector cannot be empty'
      );
    });

    it('should validate points is an array', async () => {
      await expect(
        client.upsert('test-collection', 'not-an-array' as unknown as Point[])
      ).rejects.toThrow('Points must be an array');
    });

    it('should validate points array is not empty', async () => {
      // Only empty-array is rejected client-side. The backend's
      // streaming-parser count cap is the single source of truth; the
      // SDK does not duplicate it. Mirrors Python SDK's posture.
      await expect(client.upsert('test-collection', [])).rejects.toThrow(
        'Points array cannot be empty'
      );
    });

    it('should validate point has vector array', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: {
                  size: 3,
                  distance: 'Cosine',
                },
              },
            },
          },
          schema_version: 'v1',
        });

      const invalidPoints = [
        {
          id: 1,
          vector: 'not-an-array' as unknown as number[],
        },
      ];

      await expect(
        client.upsert('test-collection', invalidPoints)
      ).rejects.toThrow('Each point must have a vector array');
    });

    it('should delete points by IDs', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections/test-collection/points/delete')
        .reply(200, { success: true });

      const result = await client.delete('test-collection', [1, 2]);

      expect(result).toBe(true);
    });

    it('should delete points by filter', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections/test-collection/points/delete')
        .reply(200, { success: true });

      const filter = { must: [{ key: 'category', match: { value: 'test' } }] };
      const result = await client.delete('test-collection', filter);

      expect(result).toBe(true);
    });

    it('should retrieve points by IDs', async () => {
      const mockPoints = [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3],
          payload: { category: 'test' },
        },
        {
          id: 2,
          vector: [0.4, 0.5, 0.6],
          payload: { category: 'test' },
        },
      ];

      // Pinned URL — retrieve has its own dedicated endpoint now.
      // Server-side, /points is unambiguously upsert (and stream-parsed),
      // and /points/retrieve is the dedicated retrieve URL. An accidental
      // revert to /points here would silently route retrieve through the
      // streaming upsert path on the backend.
      nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections/test-collection/points/retrieve')
        .reply(200, { result: mockPoints });

      const result = await client.retrieve('test-collection', [1, 2]);

      expect(result).toEqual(mockPoints);
    });

    it('should retrieve points with custom options', async () => {
      // Body-shape pin: caller-facing option is withVectors (plural,
      // camelCase) but the wire field is with_vector (singular). The
      // dedicated /points/retrieve route reads body.with_vector strictly;
      // a typo'd plural silently dropped vectors from the response.
      nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections/test-collection/points/retrieve', body => {
          return (
            Array.isArray(body.ids) &&
            body.ids[0] === 1 &&
            body.with_payload === false &&
            body.with_vector === true &&
            !('with_vectors' in body)
          );
        })
        .reply(200, { result: [] });

      await client.retrieve('test-collection', [1], {
        withPayload: false,
        withVectors: true,
      });
    });

    it('should return empty array when retrieving with empty IDs', async () => {
      const result = await client.retrieve('test-collection', []);
      expect(result).toEqual([]);
    });

    it('should count points in collection', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections/test-collection/points/count')
        .reply(200, { result: { count: 42 } });

      const count = await client.count('test-collection');

      expect(count).toBe(42);
    });

    it('should count points with filter and exact option', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections/test-collection/points/count')
        .reply(200, { result: { count: 10 } });

      const filter = { must: [{ key: 'category', match: { value: 'test' } }] };
      const count = await client.count('test-collection', {
        countFilter: filter,
        exact: true,
      });

      expect(count).toBe(10);
    });
  });

  describe('Analytics', () => {
    let client: AetherfyVectorsClient;

    beforeEach(() => {
      client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });
    });

    it('should get performance analytics', async () => {
      const mockAnalytics = {
        cacheHitRate: 94.2,
        avgLatencyMs: 45,
        requestsPerSecond: 1250,
        activeRegions: ['us-east-1', 'eu-west-1'],
      };

      nock('https://vectors.aetherfy.com')
        .get('/api/v1/analytics/performance?time_range=24h')
        .reply(200, mockAnalytics);

      const analytics = await client.getPerformanceAnalytics('24h');
      expect(analytics).toEqual(mockAnalytics);
    });

    it('should get usage stats', async () => {
      const mockUsage = {
        currentCollections: 5,
        maxCollections: 100,
        currentPoints: 50000,
        maxPoints: 1000000,
        planName: 'Developer',
      };

      nock('https://vectors.aetherfy.com')
        .get('/api/v1/analytics/usage')
        .reply(200, mockUsage);

      const usage = await client.getUsageStats();
      expect(usage).toEqual(mockUsage);
    });

    it('should get collection analytics', async () => {
      const mockAnalytics = {
        name: 'test-collection',
        totalPoints: 1000,
        searchRequests: 500,
        upsertRequests: 50,
        deleteRequests: 10,
        avgSearchLatencyMs: 30,
      };

      nock('https://vectors.aetherfy.com')
        .get('/api/v1/analytics/collections/test-collection?time_range=7d')
        .reply(200, mockAnalytics);

      const analytics = await client.getCollectionAnalytics(
        'test-collection',
        '7d'
      );
      expect(analytics).toEqual(mockAnalytics);
    });

    it('should validate collection name for collection analytics', async () => {
      await expect(client.getCollectionAnalytics('')).rejects.toThrow(
        'Collection name must be a non-empty string'
      );
    });
  });

  describe('Utility Methods', () => {
    let client: AetherfyVectorsClient;

    beforeEach(() => {
      client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });
    });

    it('should test connection successfully', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections')
        .reply(200, { collections: [] });

      const connected = await client.testConnection();
      expect(connected).toBe(true);
    });

    it('should return false on connection failure', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections')
        .replyWithError(new Error('Network Error'));

      const connected = await client.testConnection();
      expect(connected).toBe(false);
    });

    it('should dispose client cleanly', async () => {
      await expect(client.dispose()).resolves.not.toThrow();
    });
  });

  describe('Error Handling', () => {
    let client: AetherfyVectorsClient;

    beforeEach(() => {
      client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });
    });

    it('should handle HTTP errors with proper status codes', async () => {
      nock('https://vectors.aetherfy.com').get('/api/v1/collections').reply(
        401,
        {
          message: 'Unauthorized access',
          code: 'UNAUTHORIZED',
        },
        {
          'x-request-id': 'req-123',
        }
      );

      await expect(client.getCollections()).rejects.toThrow();
    });

    it('should handle errors in deleteCollection', async () => {
      nock('https://vectors.aetherfy.com')
        .delete('/api/v1/collections/test-collection')
        .reply(500, {
          message: 'Internal server error',
        });

      await expect(
        client.deleteCollection('test-collection')
      ).rejects.toThrow();
    });

    it('should throw CollectionInUseError when deleting a collection in use', async () => {
      nock('https://vectors.aetherfy.com')
        .delete('/api/v1/collections/test-collection')
        .reply(409, {
          error: {
            code: 'COLLECTION_IN_USE',
            message:
              "Collection 'test-collection' is in use by agent(s): my-agent",
            collection_name: 'test-collection',
            agents: ['my-agent', 'other-agent'],
          },
        });

      let caughtError: unknown;
      try {
        await client.deleteCollection('test-collection');
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(CollectionInUseError);
      expect((caughtError as CollectionInUseError).collectionName).toBe(
        'test-collection'
      );
      expect((caughtError as CollectionInUseError).agents).toEqual([
        'my-agent',
        'other-agent',
      ]);
    });

    it('should handle non-404 errors in collectionExists', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/test-collection')
        .reply(500, {
          message: 'Internal server error',
        });

      await expect(
        client.collectionExists('test-collection')
      ).rejects.toThrow();
    });

    it('should handle non-retryable HTTP errors in upsert', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: {
                  size: 3,
                  distance: 'Cosine',
                },
              },
            },
          },
          schema_version: 'v1',
        });

      nock('https://vectors.aetherfy.com')
        .put('/api/v1/collections/test-collection/points')
        .reply(400, {
          message: 'Bad request',
          code: 'VALIDATION_ERROR',
        });

      const points = [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3],
          payload: { category: 'test' },
        },
      ];

      await expect(client.upsert('test-collection', points)).rejects.toThrow();
    });

    it('should handle non-retryable HTTP errors in search', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections/test-collection/points/search')
        .reply(404, {
          message: 'Collection not found',
          code: 'NOT_FOUND',
        });

      await expect(
        client.search('test-collection', [0.1, 0.2, 0.3])
      ).rejects.toThrow();
    });

    it('should handle errors in delete operation', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections/test-collection/points/delete')
        .reply(500, {
          message: 'Server error',
          code: 'INTERNAL_ERROR',
        });

      await expect(client.delete('test-collection', [1])).rejects.toThrow();
    });

    it('should handle errors in retrieve operation', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections/test-collection/points/retrieve')
        .reply(503, {
          message: 'Service unavailable',
          code: 'SERVICE_UNAVAILABLE',
        });

      await expect(client.retrieve('test-collection', [1])).rejects.toThrow();
    });

    it('should handle errors in count operation', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/api/v1/collections/test-collection/points/count')
        .reply(403, {
          message: 'Forbidden',
          code: 'FORBIDDEN',
        });

      await expect(client.count('test-collection')).rejects.toThrow();
    });

    it('should handle errors in getCollection operation', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/non-existent')
        .reply(404, {
          message: 'Collection not found',
          code: 'NOT_FOUND',
        });

      await expect(client.getCollection('non-existent')).rejects.toThrow();
    });

    it('should convert generic network error to NetworkError', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections')
        .replyWithError(new Error('Network Error'));

      try {
        await client.getCollections();
        throw new Error('Expected NetworkError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkError);
        expect((error as NetworkError).message).toBe(
          'Network error: Network Error'
        );
      }
    });

    it('should convert timeout error to NetworkError', async () => {
      const error = new Error('timeout of 30000ms exceeded');
      Object.assign(error, { code: 'ECONNABORTED' });

      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections')
        .replyWithError(error);

      try {
        await client.getCollections();
        throw new Error('Expected NetworkError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkError);
        expect((error as NetworkError).message).toBe(
          'Network error: timeout of 30000ms exceeded'
        );
      }
    });

    it('should convert ECONNRESET error to NetworkError', async () => {
      const error = new Error('Connection reset by peer');
      Object.assign(error, { code: 'ECONNRESET' });

      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections')
        .replyWithError(error);

      try {
        await client.getCollections();
        throw new Error('Expected NetworkError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkError);
        expect((error as NetworkError).message).toBe(
          'Network error: Connection reset by peer'
        );
      }
    });

    it('should convert ETIMEDOUT error to NetworkError', async () => {
      const error = new Error('Connection timed out');
      Object.assign(error, { code: 'ETIMEDOUT' });

      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections')
        .replyWithError(error);

      try {
        await client.getCollections();
        throw new Error('Expected NetworkError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkError);
        expect((error as NetworkError).message).toBe(
          'Network error: Connection timed out'
        );
      }
    });

    it('should convert ECONNABORTED error to NetworkError', async () => {
      const error = new Error('Connection aborted');
      Object.assign(error, { code: 'ECONNABORTED' });

      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections')
        .replyWithError(error);

      try {
        await client.getCollections();
        throw new Error('Expected NetworkError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NetworkError);
        expect((error as NetworkError).message).toBe(
          'Network error: Connection aborted'
        );
      }
    });

    it('should wrap unexpected non-network errors as AetherfyVectorsError', async () => {
      const spy = jest
        .spyOn(HttpClient.prototype, 'get')
        .mockRejectedValueOnce(new Error('Unexpected computation error'));

      try {
        await client.getCollections();
        throw new Error('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AetherfyVectorsError);
        expect(error).not.toBeInstanceOf(NetworkError);
        expect((error as AetherfyVectorsError).message).toBe(
          'Unexpected computation error'
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('should handle createCollection errors', async () => {
      jest.useFakeTimers();

      try {
        nock('https://vectors.aetherfy.com')
          .post('/api/v1/collections')
          .times(4)
          .replyWithError(new Error('Connection failed'));

        const expectation = expect(
          client.createCollection('test-collection', {
            size: 128,
            distance: DistanceMetric.COSINE,
          })
        ).rejects.toThrow();
        await jest.runAllTimersAsync();
        await expectation;
      } finally {
        jest.useRealTimers();
      }
    });

    it('should handle invalid collection schema from server', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/invalid-schema')
        .reply(200, {
          result: {
            config: {
              params: {
                // Missing vectors config
              },
            },
          },
          schema_version: 'v1',
        });

      await expect(
        client.upsert('invalid-schema', [
          { id: 1, vector: [0.1, 0.2, 0.3], payload: {} },
        ])
      ).rejects.toThrow(ValidationError);
    });

    it('should handle points without vector array', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: {
                  size: 3,
                  distance: 'Cosine',
                },
              },
            },
          },
          schema_version: 'v1',
        });

      const pointsWithoutVector = [
        {
          id: 1,
          payload: { category: 'test' },
        } as unknown as Point,
      ];

      await expect(
        client.upsert('test-collection', pointsWithoutVector)
      ).rejects.toThrow(ValidationError);
    });

    it('should handle points with null vector', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: {
                  size: 3,
                  distance: 'Cosine',
                },
              },
            },
          },
          schema_version: 'v1',
        });

      const pointsWithNullVector = [
        {
          id: 1,
          vector: null,
          payload: { category: 'test' },
        } as unknown as Point,
      ];

      await expect(
        client.upsert('test-collection', pointsWithNullVector)
      ).rejects.toThrow(ValidationError);
    });

    it('should handle points with non-array vector', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: {
                  size: 3,
                  distance: 'Cosine',
                },
              },
            },
          },
          schema_version: 'v1',
        });

      const pointsWithStringVector = [
        {
          id: 1,
          vector: 'not an array',
          payload: { category: 'test' },
        } as unknown as Point,
      ];

      await expect(
        client.upsert('test-collection', pointsWithStringVector)
      ).rejects.toThrow(ValidationError);
    });

    it('should pass through AetherfyVectorsError unchanged', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/test-collection')
        .reply(500, {
          message: 'Server error',
          code: 'INTERNAL_ERROR',
        });

      try {
        await client.collectionExists('test-collection');
        throw new Error('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AetherfyVectorsError);
      }
    });

    it('should handle AetherfyVectorsError passthrough', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections')
        .reply(500, {
          message: 'Server error',
        });

      await expect(client.getCollections()).rejects.toThrow(
        AetherfyVectorsError
      );
    });

    it('should handle generic network errors', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections')
        .replyWithError(new Error('Connection failed'));

      await expect(client.getCollections()).rejects.toThrow(NetworkError);
    });

    it('should handle ECONNABORTED errors', async () => {
      const error = new Error('Connection ECONNABORTED');

      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections')
        .replyWithError(error);

      await expect(client.getCollections()).rejects.toThrow(NetworkError);
    });

    it('should handle timeout errors', async () => {
      const error = new Error('Request timeout');

      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections')
        .replyWithError(error);

      await expect(client.getCollections()).rejects.toThrow(NetworkError);
    });

    it('should handle upsert errors that are not 500 status', async () => {
      // Warm both schema caches with real timers before activating fake timers,
      // so the upsert under fake timers only exercises the PUT retry path.
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: {
                  size: 3,
                  distance: 'Cosine',
                },
              },
            },
          },
          schema_version: 'v1',
        });
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(404, { error: { message: 'Schema not found' } });
      nock('https://vectors.aetherfy.com')
        .put('/api/v1/collections/test-collection/points')
        .reply(200, { status: 'ok' });

      await client.upsert('test-collection', [
        { id: 0, vector: [0.1, 0.2, 0.3], payload: {} },
      ]);

      jest.useFakeTimers();

      try {
        nock('https://vectors.aetherfy.com')
          .put('/api/v1/collections/test-collection/points')
          .times(4)
          .replyWithError(new Error('Database connection failed'));

        const expectation = expect(
          client.upsert('test-collection', [
            { id: 1, vector: [0.1, 0.2, 0.3], payload: {} },
          ])
        ).rejects.toThrow(NetworkError);
        await jest.runAllTimersAsync();
        await expectation;
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('Schema Management', () => {
    let client: AetherfyVectorsClient;

    beforeEach(() => {
      client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });
    });

    describe('getSchema', () => {
      it('should fetch schema successfully', async () => {
        nock('https://vectors.aetherfy.com')
          .get('/api/v1/schema/test-collection')
          .reply(200, {
            schema: {
              fields: {
                price: { type: 'integer', required: true },
                name: { type: 'string', required: true },
              },
            },
            enforcement_mode: 'strict',
            etag: 'schema_abc123',
            description: 'Product schema',
          });

        const schema = await client.getSchema('test-collection');

        expect(schema).not.toBeNull();
        expect(schema?.fields.price.type).toBe('integer');
        expect(schema?.fields.name.type).toBe('string');
        expect(schema?.description).toBe('Product schema');
      });

      it('should return null when schema not found', async () => {
        nock('https://vectors.aetherfy.com')
          .get('/api/v1/schema/test-collection')
          .reply(404, { error: { message: 'Schema not found' } });

        const schema = await client.getSchema('test-collection');
        expect(schema).toBeNull();
      });

      it('should always fetch from server and update cache', async () => {
        const schemaReply = {
          schema: {
            fields: { price: { type: 'integer', required: true } },
          },
          enforcement_mode: 'off',
          etag: 'abc123',
          description: null,
        };

        // Two calls require two nock intercepts — always fetches from server
        nock('https://vectors.aetherfy.com')
          .get('/api/v1/schema/test-collection')
          .reply(200, schemaReply);
        nock('https://vectors.aetherfy.com')
          .get('/api/v1/schema/test-collection')
          .reply(200, schemaReply);

        await client.getSchema('test-collection');
        const schema = await client.getSchema('test-collection');

        expect(schema).not.toBeNull();
        expect(schema?.fields.price.type).toBe('integer');
      });
    });

    describe('setSchema', () => {
      it('should set schema successfully', async () => {
        nock('https://vectors.aetherfy.com')
          .put('/api/v1/schema/test-collection', {
            schema: {
              fields: {
                price: { type: 'integer', required: true },
              },
            },
            enforcement_mode: 'strict',
          })
          .reply(200, { etag: 'new_etag_123' });

        const result = await client.setSchema(
          'test-collection',
          {
            fields: {
              price: { type: 'integer', required: true },
            },
          },
          'strict'
        );

        expect(result).toBe('new_etag_123');
      });

      it('should default to off enforcement mode', async () => {
        const scope = nock('https://vectors.aetherfy.com')
          .put('/api/v1/schema/test-collection', body => {
            return body.enforcement_mode === 'off';
          })
          .reply(200, { etag: 'etag_456' });

        await client.setSchema('test-collection', {
          fields: { name: { type: 'string', required: false } },
        });

        expect(scope.isDone()).toBe(true);
      });
    });

    describe('deleteSchema', () => {
      it('should delete schema successfully', async () => {
        nock('https://vectors.aetherfy.com')
          .delete('/api/v1/schema/test-collection')
          .reply(200, { success: true });

        const result = await client.deleteSchema('test-collection');
        expect(result).toBe(true);
      });

      it('should throw SchemaNotFoundError when schema does not exist', async () => {
        nock('https://vectors.aetherfy.com')
          .delete('/api/v1/schema/test-collection')
          .reply(404, { error: { message: 'Schema not found' } });

        await expect(client.deleteSchema('test-collection')).rejects.toThrow(
          SchemaNotFoundError
        );
      });

      it('should propagate non-404 errors from the server', async () => {
        nock('https://vectors.aetherfy.com')
          .delete('/api/v1/schema/test-collection')
          .reply(500, { error: { message: 'Internal server error' } });

        await expect(client.deleteSchema('test-collection')).rejects.toThrow(
          AetherfyVectorsError
        );
      });

      it('should clear cache after deletion', async () => {
        // First set a schema (which caches it)
        nock('https://vectors.aetherfy.com')
          .put('/api/v1/schema/test-collection')
          .reply(200, { etag: 'abc' });

        await client.setSchema('test-collection', {
          fields: { test: { type: 'string', required: false } },
        });

        // Delete it
        nock('https://vectors.aetherfy.com')
          .delete('/api/v1/schema/test-collection')
          .reply(200, { success: true });

        await client.deleteSchema('test-collection');

        // Try to get it - should fetch from server (cache cleared)
        nock('https://vectors.aetherfy.com')
          .get('/api/v1/schema/test-collection')
          .reply(404, {});

        const schema = await client.getSchema('test-collection');
        expect(schema).toBeNull();
      });
    });

    describe('analyzeSchema', () => {
      it('should analyze schema successfully', async () => {
        nock('https://vectors.aetherfy.com')
          .post('/api/v1/schema/test-collection/analyze', {
            sample_size: 1000,
          })
          .reply(200, {
            collection: 'test-collection',
            sample_size: 1000,
            total_points: 5000,
            fields: {
              price: {
                presence: 1.0,
                types: { integer: 1.0 },
                warnings: [],
              },
            },
            suggested_schema: {
              fields: {
                price: { type: 'integer', required: true },
              },
            },
            processing_time_ms: 42,
          });

        const analysis = await client.analyzeSchema('test-collection', 1000);

        expect(analysis.collection).toBe('test-collection');
        expect(analysis.sampleSize).toBe(1000);
        expect(analysis.suggestedSchema.fields.price.type).toBe('integer');
      });

      it('should use default sample size', async () => {
        const scope = nock('https://vectors.aetherfy.com')
          .post('/api/v1/schema/test-collection/analyze', body => {
            return body.sample_size === 1000;
          })
          .reply(200, {
            collection: 'test-collection',
            sample_size: 1000,
            total_points: 5000,
            fields: {},
            suggested_schema: { fields: {} },
            processing_time_ms: 10,
          });

        await client.analyzeSchema('test-collection');
        expect(scope.isDone()).toBe(true);
      });

      it('should throw ValidationError when sampleSize is below 100', async () => {
        await expect(
          client.analyzeSchema('test-collection', 99)
        ).rejects.toThrow(ValidationError);
      });

      it('should throw ValidationError when sampleSize exceeds 10000', async () => {
        await expect(
          client.analyzeSchema('test-collection', 10001)
        ).rejects.toThrow(ValidationError);
      });

      it('404 evicts both caches and re-throws (collection gone upstream)', async () => {
        // Seed both caches as if the collection had been used before.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = client as any;
        c.schemaCache.set('test-collection', { size: 4, distance: 'Cosine' });
        c.payloadSchemaCache.set('test-collection', {
          schema: null,
          enforcementMode: 'off',
          etag: null,
          description: null,
        });

        nock('https://vectors.aetherfy.com')
          .post('/api/v1/schema/test-collection/analyze')
          .reply(404, { message: 'Collection not found' });

        await expect(
          client.analyzeSchema('test-collection', 1000)
        ).rejects.toThrow();

        // Both caches dropped — uniform "404 → evict" semantics.
        expect(c.schemaCache.has('test-collection')).toBe(false);
        expect(c.payloadSchemaCache.has('test-collection')).toBe(false);
      });
    });

    describe('setSchema 4xx eviction', () => {
      it('404 evicts both caches and re-throws', async () => {
        // PUT /schema/<name> on a non-existent collection 404s
        // unambiguously; the catch path drops the local caches so
        // a subsequent call doesn't keep believing the collection exists.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = client as any;
        c.schemaCache.set('test-collection', { size: 4, distance: 'Cosine' });
        c.payloadSchemaCache.set('test-collection', {
          schema: null,
          enforcementMode: 'off',
          etag: null,
          description: null,
        });

        nock('https://vectors.aetherfy.com')
          .put('/api/v1/schema/test-collection')
          .reply(404, { message: 'Collection not found' });

        await expect(
          client.setSchema(
            'test-collection',
            { fields: { name: { type: 'string', required: false } } },
            'off'
          )
        ).rejects.toThrow();

        expect(c.schemaCache.has('test-collection')).toBe(false);
        expect(c.payloadSchemaCache.has('test-collection')).toBe(false);
      });
    });

    describe('schema 404 disambiguation', () => {
      it('getSchema 404 with COLLECTION_NOT_FOUND evicts both caches', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = client as any;
        c.schemaCache.set('test-collection', { size: 4, distance: 'Cosine' });
        c.payloadSchemaCache.set('test-collection', {
          schema: null,
          enforcementMode: 'off',
          etag: null,
          description: null,
        });

        nock('https://vectors.aetherfy.com')
          .get('/api/v1/schema/test-collection')
          .reply(404, {
            error: { code: 'COLLECTION_NOT_FOUND', message: 'gone' },
          });

        const schema = await client.getSchema('test-collection');
        expect(schema).toBeNull();
        // Collection is gone — caches dropped.
        expect(c.schemaCache.has('test-collection')).toBe(false);
        expect(c.payloadSchemaCache.has('test-collection')).toBe(false);
      });

      it('getSchema 404 with SCHEMA_NOT_DEFINED keeps caches', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = client as any;
        c.schemaCache.set('test-collection', { size: 4, distance: 'Cosine' });
        c.payloadSchemaCache.set('test-collection', {
          schema: null,
          enforcementMode: 'off',
          etag: null,
          description: null,
        });

        nock('https://vectors.aetherfy.com')
          .get('/api/v1/schema/test-collection')
          .reply(404, {
            error: { code: 'SCHEMA_NOT_DEFINED', message: 'no schema set' },
          });

        const schema = await client.getSchema('test-collection');
        expect(schema).toBeNull();
        // Collection is fine, just no schema set — caches preserved.
        expect(c.schemaCache.has('test-collection')).toBe(true);
        expect(c.payloadSchemaCache.has('test-collection')).toBe(true);
      });

      it('deleteSchema 404 with COLLECTION_NOT_FOUND evicts and raises SchemaNotFoundError', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = client as any;
        c.schemaCache.set('test-collection', { size: 4, distance: 'Cosine' });
        c.payloadSchemaCache.set('test-collection', {
          schema: null,
          enforcementMode: 'off',
          etag: null,
          description: null,
        });

        nock('https://vectors.aetherfy.com')
          .delete('/api/v1/schema/test-collection')
          .reply(404, {
            error: { code: 'COLLECTION_NOT_FOUND', message: 'gone' },
          });

        await expect(client.deleteSchema('test-collection')).rejects.toThrow(
          SchemaNotFoundError
        );
        expect(c.schemaCache.has('test-collection')).toBe(false);
        expect(c.payloadSchemaCache.has('test-collection')).toBe(false);
      });

      it('deleteSchema 404 with SCHEMA_NOT_DEFINED keeps caches and raises SchemaNotFoundError', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = client as any;
        c.schemaCache.set('test-collection', { size: 4, distance: 'Cosine' });
        c.payloadSchemaCache.set('test-collection', {
          schema: null,
          enforcementMode: 'off',
          etag: null,
          description: null,
        });

        nock('https://vectors.aetherfy.com')
          .delete('/api/v1/schema/test-collection')
          .reply(404, {
            error: { code: 'SCHEMA_NOT_DEFINED', message: 'no schema set' },
          });

        await expect(client.deleteSchema('test-collection')).rejects.toThrow(
          SchemaNotFoundError
        );
        // Caches preserved — collection is still around.
        expect(c.schemaCache.has('test-collection')).toBe(true);
        expect(c.payloadSchemaCache.has('test-collection')).toBe(true);
      });
    });

    describe('upsert schema-fetch error path', () => {
      it('non-AetherfyVectorsError from fetchAndCacheSchema is wrapped via handleError and re-thrown', async () => {
        // The catch at upsert's schema-fetch site has two branches:
        //   - error instanceof AetherfyVectorsError → re-throw as-is
        //   - else → wrap via handleError and throw
        // The else-branch covers raw network errors. We trigger it by
        // forcing nock to error the GET with a non-HTTP failure.
        nock('https://vectors.aetherfy.com')
          .get('/api/v1/collections/test-collection')
          .replyWithError('socket hang up');

        await expect(
          client.upsert('test-collection', [
            { id: 1, vector: [0.1, 0.2, 0.3, 0.4] },
          ])
        ).rejects.toThrow();
      });
    });

    describe('refreshSchema', () => {
      it('should cache refreshed schema so subsequent upserts use it without re-fetching', async () => {
        // First upsert — populates schemaCache (vector) and payloadSchemaCache (payload)
        nock('https://vectors.aetherfy.com')
          .get('/api/v1/collections/test-collection')
          .reply(200, {
            result: {
              config: { params: { vectors: { size: 2, distance: 'Cosine' } } },
            },
            schema_version: 'v1',
          });
        nock('https://vectors.aetherfy.com')
          .get('/api/v1/schema/test-collection')
          .reply(200, {
            schema: { fields: { old: { type: 'string', required: false } } },
            enforcement_mode: 'off',
            etag: 'old_etag',
            description: null,
          });
        nock('https://vectors.aetherfy.com')
          .put('/api/v1/collections/test-collection/points')
          .reply(200, { status: 'ok' });

        await client.upsert('test-collection', [
          { id: 1, vector: [0.1, 0.2], payload: {} },
        ]);

        // refreshSchema clears payloadSchemaCache and re-populates it with the new schema
        nock('https://vectors.aetherfy.com')
          .get('/api/v1/schema/test-collection')
          .reply(200, {
            schema: {
              fields: { required_field: { type: 'integer', required: true } },
            },
            enforcement_mode: 'strict',
            etag: 'new_etag',
            description: null,
          });

        await client.refreshSchema('test-collection');

        // Second upsert — no GET /schema mock: proves the refreshed schema came from cache.
        // The new strict schema requires 'required_field'; submitting without it
        // must throw SchemaValidationError, confirming the new schema is enforced.
        await expect(
          client.upsert('test-collection', [
            { id: 2, vector: [0.1, 0.2], payload: {} },
          ])
        ).rejects.toThrow(SchemaValidationError);
      });
    });
  });

  describe('Cleanup', () => {
    it('should destroy client resources', () => {
      const testClient = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: true,
      });

      expect(() => testClient.destroy()).not.toThrow();
    });

    it('should destroy client without connection pooling', () => {
      const testClient = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });

      expect(() => testClient.destroy()).not.toThrow();
    });
  });
});
