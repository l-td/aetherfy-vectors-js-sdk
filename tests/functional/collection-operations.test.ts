/**
 * Integration tests for collection operations
 */

import { AetherfyVectorsClient } from '../../src/client';
import { DistanceMetric } from '../../src/models';
import { CollectionNotFoundError, ValidationError } from '../../src/exceptions';

// Mock fetch for integration tests
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('Collection Operations Integration', () => {
  let client: AetherfyVectorsClient;

  beforeEach(() => {
    client = new AetherfyVectorsClient({
      apiKey: 'afy_test_integration_key_12345',
    });
    mockFetch.mockClear();
  });

  describe('Collection Lifecycle', () => {
    const collectionName = 'test-integration-collection';

    it('should complete full collection lifecycle', async () => {
      // 1. Create collection
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({ success: true }),
      });

      const created = await client.createCollection(collectionName, {
        size: 128,
        distance: DistanceMetric.COSINE,
      });
      expect(created).toBe(true);

      // 2. Verify collection exists
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'application/json']]),
        json: () =>
          Promise.resolve({
            name: collectionName,
            config: { size: 128, distance: 'Cosine' },
          }),
      });

      const exists = await client.collectionExists(collectionName);
      expect(exists).toBe(true);

      // 3. Get collection details
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'application/json']]),
        json: () =>
          Promise.resolve({
            name: collectionName,
            config: { size: 128, distance: 'Cosine' },
            pointsCount: 0,
            status: 'active',
          }),
      });

      const collection = await client.getCollection(collectionName);
      expect(collection.name).toBe(collectionName);
      expect(collection.config.size).toBe(128);
      expect(collection.config.distance).toBe(DistanceMetric.COSINE);

      // 4. List collections (should include our collection)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'application/json']]),
        json: () =>
          Promise.resolve({
            collections: [
              {
                name: collectionName,
                config: { size: 128, distance: 'Cosine' },
              },
              {
                name: 'another-collection',
                config: { size: 256, distance: 'Euclidean' },
              },
            ],
          }),
      });

      const collections = await client.getCollections();
      expect(collections).toHaveLength(2);
      expect(collections.find(c => c.name === collectionName)).toBeDefined();

      // 5. Delete collection
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        statusText: 'No Content',
        headers: new Map(),
        json: () => Promise.resolve({}),
      });

      const deleted = await client.deleteCollection(collectionName);
      expect(deleted).toBe(true);

      // 6. Verify collection no longer exists
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({ message: 'Collection not found' }),
      });

      const existsAfterDelete = await client.collectionExists(collectionName);
      expect(existsAfterDelete).toBe(false);
    });
  });

  describe('Collection Configuration Variants', () => {
    it('should create collections with different distance metrics', async () => {
      const testCases = [
        { distance: DistanceMetric.COSINE, size: 128 },
        { distance: DistanceMetric.EUCLIDEAN, size: 256 },
        { distance: DistanceMetric.DOT, size: 512 },
        { distance: DistanceMetric.MANHATTAN, size: 1024 },
      ];

      for (const config of testCases) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 201,
          statusText: 'Created',
          headers: new Map([['content-type', 'application/json']]),
          json: () => Promise.resolve({ success: true }),
        });

        const collectionName = `test-${config.distance.toLowerCase()}-${config.size}`;
        const result = await client.createCollection(collectionName, config);

        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
          'https://vectors.aetherfy.com/collections',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              name: collectionName,
              vectors_config: config,
            }),
          })
        );
      }
    });

    it('should handle legacy configuration format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({ success: true }),
      });

      // Test legacy format with 'dimension' instead of 'size'
      const result = await client.createCollection('legacy-test', {
        dimension: 384,
        metric: DistanceMetric.COSINE,
      } as Record<string, unknown>);

      expect(result).toBe(true);
    });
  });

  describe('Error Scenarios', () => {
    it('should handle collection creation conflicts', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        headers: new Map([['content-type', 'application/json']]),
        json: () =>
          Promise.resolve({
            message: 'Collection already exists',
            conflictingResource: 'existing-collection',
          }),
      });

      await expect(
        client.createCollection('existing-collection', {
          size: 128,
          distance: DistanceMetric.COSINE,
        })
      ).rejects.toThrow();
    });

    it('should handle collection not found errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Map([['content-type', 'application/json']]),
        json: () =>
          Promise.resolve({
            message: 'Collection not found',
            collectionName: 'non-existent',
          }),
      });

      await expect(client.getCollection('non-existent')).rejects.toThrow(
        CollectionNotFoundError
      );
    });

    it('should validate collection configuration', async () => {
      // Invalid size
      await expect(
        client.createCollection('invalid-size', {
          size: 0,
          distance: DistanceMetric.COSINE,
        })
      ).rejects.toThrow(ValidationError);

      // Invalid distance metric
      await expect(
        client.createCollection('invalid-metric', {
          size: 128,
          distance: 'InvalidMetric' as string,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('should handle authentication errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: new Map([['content-type', 'application/json']]),
        json: () =>
          Promise.resolve({
            message: 'Invalid API key',
          }),
      });

      await expect(
        client.createCollection('auth-test', {
          size: 128,
          distance: DistanceMetric.COSINE,
        })
      ).rejects.toThrow();
    });

    it('should handle rate limiting', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Map([
          ['content-type', 'application/json'],
          ['retry-after', '60'],
        ]),
        json: () =>
          Promise.resolve({
            message: 'Rate limit exceeded',
            retryAfter: 60,
          }),
      });

      await expect(client.getCollections()).rejects.toThrow();
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle multiple collection operations concurrently', async () => {
      const operations = ['collection-1', 'collection-2', 'collection-3'];

      // Mock responses for concurrent creation
      operations.forEach(() => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 201,
          statusText: 'Created',
          headers: new Map([['content-type', 'application/json']]),
          json: () => Promise.resolve({ success: true }),
        });
      });

      const results = await Promise.all(
        operations.map(name =>
          client.createCollection(name, {
            size: 128,
            distance: DistanceMetric.COSINE,
          })
        )
      );

      results.forEach(result => {
        expect(result).toBe(true);
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should handle mixed success and failure scenarios', async () => {
      // First call succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        statusText: 'Created',
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({ success: true }),
      });

      // Second call fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        headers: new Map([['content-type', 'application/json']]),
        json: () =>
          Promise.resolve({
            message: 'Collection already exists',
          }),
      });

      const [result1, result2] = await Promise.allSettled([
        client.createCollection('success-collection', {
          size: 128,
          distance: DistanceMetric.COSINE,
        }),
        client.createCollection('conflict-collection', {
          size: 128,
          distance: DistanceMetric.COSINE,
        }),
      ]);

      expect(result1.status).toBe('fulfilled');
      expect(result2.status).toBe('rejected');
    });
  });
});
