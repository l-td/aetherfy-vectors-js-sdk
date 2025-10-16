/**
 * Unit tests for AetherfyVectorsClient
 */

import { AetherfyVectorsClient } from '../../src/client';
import { DistanceMetric, VectorConfig, Point } from '../../src/models';
import { ValidationError } from '../../src/exceptions';
import fetchMock from 'jest-fetch-mock';

describe('AetherfyVectorsClient', () => {
  beforeEach(() => {
    fetchMock.resetMocks();
    // Mock successful responses by default
    fetchMock.mockResponse(JSON.stringify({ collections: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  describe('Constructor', () => {
    it('should create client with explicit API key', () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
      });
      expect(client).toBeInstanceOf(AetherfyVectorsClient);
    });

    it('should throw error with invalid API key', () => {
      expect(() => {
        new AetherfyVectorsClient({
          apiKey: 'invalid_key',
        });
      }).toThrow("Invalid API key format. API key must start with 'afy_'");
    });

    it('should use custom endpoint when provided', () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        endpoint: 'https://custom.endpoint.com',
      });
      expect(client).toBeInstanceOf(AetherfyVectorsClient);
    });
  });

  describe('Collection Management', () => {
    let client: AetherfyVectorsClient;

    beforeEach(() => {
      client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
      });
    });

    it('should create collection successfully', async () => {
      fetchMock.mockResponseOnce(JSON.stringify({ success: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });

      const result = await client.createCollection('test-collection', {
        size: 128,
        distance: DistanceMetric.COSINE,
      });

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://vectors.aetherfy.com/collections',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer afy_test_1234567890123456',
          }),
          body: JSON.stringify({
            name: 'test-collection',
            vectors: {
              size: 128,
              distance: DistanceMetric.COSINE,
            },
          }),
        })
      );
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

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ collections: mockCollections }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const collections = await client.getCollections();

      expect(collections).toEqual(mockCollections);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://vectors.aetherfy.com/collections',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer afy_test_1234567890123456',
          }),
        })
      );
    });

    it('should check if collection exists', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'test-collection' }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const exists = await client.collectionExists('test-collection');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent collection', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Collection not found' }), {
          status: 404,
          statusText: 'Not Found',
          headers: { 'content-type': 'application/json' },
        })
      );

      const exists = await client.collectionExists('non-existent');
      expect(exists).toBe(false);
    });

    it('should delete collection', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(null, {
          status: 204,
          statusText: 'No Content',
        })
      );

      const result = await client.deleteCollection('test-collection');
      expect(result).toBe(true);
    });

    it('should get collection information', async () => {
      const mockCollection = {
        name: 'test-collection',
        config: { size: 128, distance: 'Cosine' },
        pointsCount: 1000,
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockCollection), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const collection = await client.getCollection('test-collection');

      expect(collection).toEqual(mockCollection);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://vectors.aetherfy.com/collections/test-collection',
        expect.objectContaining({
          method: 'GET',
        })
      );
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
  });

  describe('Vector Operations', () => {
    let client: AetherfyVectorsClient;

    beforeEach(() => {
      client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
      });
    });

    it('should upsert points successfully', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const points = [
        {
          id: 'point1',
          vector: [0.1, 0.2, 0.3],
          payload: { category: 'test' },
        },
      ];

      const result = await client.upsert('test-collection', points);
      expect(result).toBe(true);
    });

    it('should validate point data', async () => {
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

      const invalidVector = [
        {
          id: 'point1',
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
          id: 'point1',
          score: 0.95,
          payload: { category: 'test' },
        },
      ];

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: mockResults }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

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
      await expect(client.upsert('test-collection', [])).rejects.toThrow(
        'Points array cannot be empty'
      );
    });

    it('should validate batch size limit', async () => {
      const largePointsArray = Array(1001).fill({
        id: 'point1',
        vector: [0.1, 0.2, 0.3],
      });

      await expect(
        client.upsert('test-collection', largePointsArray)
      ).rejects.toThrow('Batch size cannot exceed 1000 points');
    });

    it('should validate point has vector array', async () => {
      const invalidPoints = [
        {
          id: 'point1',
          vector: 'not-an-array' as unknown as number[],
        },
      ];

      await expect(
        client.upsert('test-collection', invalidPoints)
      ).rejects.toThrow('Each point must have a vector array');
    });

    it('should delete points by IDs', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.delete('test-collection', [
        'point1',
        'point2',
      ]);

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://vectors.aetherfy.com/collections/test-collection/points/delete',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ points: ['point1', 'point2'] }),
        })
      );
    });

    it('should delete points by filter', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const filter = { must: [{ key: 'category', match: { value: 'test' } }] };
      const result = await client.delete('test-collection', filter);

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://vectors.aetherfy.com/collections/test-collection/points/delete',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ filter }),
        })
      );
    });

    it('should retrieve points by IDs', async () => {
      const mockPoints = [
        {
          id: 'point1',
          vector: [0.1, 0.2, 0.3],
          payload: { category: 'test' },
        },
        {
          id: 'point2',
          vector: [0.4, 0.5, 0.6],
          payload: { category: 'test' },
        },
      ];

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: mockPoints }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.retrieve('test-collection', [
        'point1',
        'point2',
      ]);

      expect(result).toEqual(mockPoints);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://vectors.aetherfy.com/collections/test-collection/points',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            ids: ['point1', 'point2'],
            with_payload: true,
            with_vectors: false,
          }),
        })
      );
    });

    it('should retrieve points with custom options', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      await client.retrieve('test-collection', ['point1'], {
        withPayload: false,
        withVectors: true,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://vectors.aetherfy.com/collections/test-collection/points',
        expect.objectContaining({
          body: JSON.stringify({
            ids: ['point1'],
            with_payload: false,
            with_vectors: true,
          }),
        })
      );
    });

    it('should return empty array when retrieving with empty IDs', async () => {
      const result = await client.retrieve('test-collection', []);
      expect(result).toEqual([]);
    });

    it('should count points in collection', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { count: 42 } }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const count = await client.count('test-collection');

      expect(count).toBe(42);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://vectors.aetherfy.com/collections/test-collection/points/count',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            filter: undefined,
            exact: false,
          }),
        })
      );
    });

    it('should count points with filter and exact option', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { count: 10 } }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const filter = { must: [{ key: 'category', match: { value: 'test' } }] };
      const count = await client.count('test-collection', {
        countFilter: filter,
        exact: true,
      });

      expect(count).toBe(10);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://vectors.aetherfy.com/collections/test-collection/points/count',
        expect.objectContaining({
          body: JSON.stringify({
            filter,
            exact: true,
          }),
        })
      );
    });
  });

  describe('Analytics', () => {
    let client: AetherfyVectorsClient;

    beforeEach(() => {
      client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
      });
    });

    it('should get performance analytics', async () => {
      const mockAnalytics = {
        cacheHitRate: 94.2,
        avgLatencyMs: 45,
        requestsPerSecond: 1250,
        activeRegions: ['us-east-1', 'eu-west-1'],
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockAnalytics), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

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

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockUsage), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

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

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockAnalytics), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

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
      });
    });

    it('should test connection successfully', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ collections: [] }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const connected = await client.testConnection();
      expect(connected).toBe(true);
    });

    it('should return false on connection failure', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

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
      });
    });

    it('should handle HTTP errors with proper status codes', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'Unauthorized access',
            code: 'UNAUTHORIZED',
          }),
          {
            status: 401,
            statusText: 'Unauthorized',
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'req-123',
            },
          }
        )
      );

      await expect(client.getCollections()).rejects.toThrow();
    });

    it('should handle non-retryable HTTP errors in upsert', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'Bad request',
            code: 'VALIDATION_ERROR',
          }),
          {
            status: 400,
            statusText: 'Bad Request',
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      const points = [
        {
          id: 'point1',
          vector: [0.1, 0.2, 0.3],
          payload: { category: 'test' },
        },
      ];

      await expect(client.upsert('test-collection', points)).rejects.toThrow();
    });

    it('should handle non-retryable HTTP errors in search', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'Collection not found',
            code: 'NOT_FOUND',
          }),
          {
            status: 404,
            statusText: 'Not Found',
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      await expect(
        client.search('test-collection', [0.1, 0.2, 0.3])
      ).rejects.toThrow();
    });

    it('should handle errors in delete operation', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'Server error',
            code: 'INTERNAL_ERROR',
          }),
          {
            status: 500,
            statusText: 'Internal Server Error',
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      await expect(
        client.delete('test-collection', ['point1'])
      ).rejects.toThrow();
    });

    it('should handle errors in retrieve operation', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'Service unavailable',
            code: 'SERVICE_UNAVAILABLE',
          }),
          {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      await expect(
        client.retrieve('test-collection', ['point1'])
      ).rejects.toThrow();
    });

    it('should handle errors in count operation', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'Forbidden',
            code: 'FORBIDDEN',
          }),
          {
            status: 403,
            statusText: 'Forbidden',
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      await expect(client.count('test-collection')).rejects.toThrow();
    });

    it('should handle errors in getCollection operation', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'Collection not found',
            code: 'NOT_FOUND',
          }),
          {
            status: 404,
            statusText: 'Not Found',
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      await expect(client.getCollection('non-existent')).rejects.toThrow();
    });
  });
});
