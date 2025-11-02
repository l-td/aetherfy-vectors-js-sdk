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
} from '../../src/exceptions';

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
      nock('https://vectors.aetherfy.com')
        .post('/collections')
        .reply(201, { success: true });

      const result = await client.createCollection('test-collection', {
        size: 128,
        distance: DistanceMetric.COSINE,
      });

      expect(result).toBe(true);
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
        .get('/collections')
        .reply(200, { collections: mockCollections });

      const collections = await client.getCollections();

      expect(collections).toEqual(mockCollections);
    });

    it('should check if collection exists', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(200, { name: 'test-collection' });

      const exists = await client.collectionExists('test-collection');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent collection', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/collections/non-existent')
        .reply(404, { message: 'Collection not found' });

      const exists = await client.collectionExists('non-existent');
      expect(exists).toBe(false);
    });

    it('should delete collection', async () => {
      nock('https://vectors.aetherfy.com')
        .delete('/collections/test-collection')
        .reply(204);

      const result = await client.deleteCollection('test-collection');
      expect(result).toBe(true);
    });

    it('should get collection information', async () => {
      const mockCollection = {
        name: 'test-collection',
        config: { size: 128, distance: 'Cosine' },
        pointsCount: 1000,
      };

      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(200, mockCollection);

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
        .get('/collections/test-collection')
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
        .put('/collections/test-collection/points')
        .reply(200, { success: true });

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
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
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

      nock('https://vectors.aetherfy.com')
        .post('/collections/test-collection/points/search')
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
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
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
          id: 'point1',
          vector: 'not-an-array' as unknown as number[],
        },
      ];

      await expect(
        client.upsert('test-collection', invalidPoints)
      ).rejects.toThrow('Each point must have a vector array');
    });

    it('should delete points by IDs', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/collections/test-collection/points/delete')
        .reply(200, { success: true });

      const result = await client.delete('test-collection', [
        'point1',
        'point2',
      ]);

      expect(result).toBe(true);
    });

    it('should delete points by filter', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/collections/test-collection/points/delete')
        .reply(200, { success: true });

      const filter = { must: [{ key: 'category', match: { value: 'test' } }] };
      const result = await client.delete('test-collection', filter);

      expect(result).toBe(true);
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

      nock('https://vectors.aetherfy.com')
        .post('/collections/test-collection/points')
        .reply(200, { result: mockPoints });

      const result = await client.retrieve('test-collection', [
        'point1',
        'point2',
      ]);

      expect(result).toEqual(mockPoints);
    });

    it('should retrieve points with custom options', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/collections/test-collection/points')
        .reply(200, { result: [] });

      await client.retrieve('test-collection', ['point1'], {
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
        .post('/collections/test-collection/points/count')
        .reply(200, { result: { count: 42 } });

      const count = await client.count('test-collection');

      expect(count).toBe(42);
    });

    it('should count points with filter and exact option', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/collections/test-collection/points/count')
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
        .get('/analytics/performance?time_range=24h')
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
        .get('/analytics/usage')
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
        .get('/analytics/collections/test-collection?time_range=7d')
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
        .get('/collections')
        .reply(200, { collections: [] });

      const connected = await client.testConnection();
      expect(connected).toBe(true);
    });

    it('should return false on connection failure', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/collections')
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
      nock('https://vectors.aetherfy.com').get('/collections').reply(
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
        .delete('/collections/test-collection')
        .reply(500, {
          message: 'Internal server error',
        });

      await expect(
        client.deleteCollection('test-collection')
      ).rejects.toThrow();
    });

    it('should handle non-404 errors in collectionExists', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(500, {
          message: 'Internal server error',
        });

      await expect(
        client.collectionExists('test-collection')
      ).rejects.toThrow();
    });

    it('should handle non-retryable HTTP errors in upsert', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
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
        .put('/collections/test-collection/points')
        .reply(400, {
          message: 'Bad request',
          code: 'VALIDATION_ERROR',
        });

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
      nock('https://vectors.aetherfy.com')
        .post('/collections/test-collection/points/search')
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
        .post('/collections/test-collection/points/delete')
        .reply(500, {
          message: 'Server error',
          code: 'INTERNAL_ERROR',
        });

      await expect(
        client.delete('test-collection', ['point1'])
      ).rejects.toThrow();
    });

    it('should handle errors in retrieve operation', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/collections/test-collection/points')
        .reply(503, {
          message: 'Service unavailable',
          code: 'SERVICE_UNAVAILABLE',
        });

      await expect(
        client.retrieve('test-collection', ['point1'])
      ).rejects.toThrow();
    });

    it('should handle errors in count operation', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/collections/test-collection/points/count')
        .reply(403, {
          message: 'Forbidden',
          code: 'FORBIDDEN',
        });

      await expect(client.count('test-collection')).rejects.toThrow();
    });

    it('should handle errors in getCollection operation', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/collections/non-existent')
        .reply(404, {
          message: 'Collection not found',
          code: 'NOT_FOUND',
        });

      await expect(client.getCollection('non-existent')).rejects.toThrow();
    });

    it('should convert generic network error to NetworkError', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/collections')
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
        .get('/collections')
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
        .get('/collections')
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
        .get('/collections')
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
        .get('/collections')
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

    it('should handle createCollection errors', async () => {
      nock('https://vectors.aetherfy.com')
        .post('/collections')
        .replyWithError(new Error('Connection failed'));

      await expect(
        client.createCollection('test-collection', {
          size: 128,
          distance: DistanceMetric.COSINE,
        })
      ).rejects.toThrow();
    });

    it('should handle invalid collection schema from server', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/collections/invalid-schema')
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
          { id: '1', vector: [0.1, 0.2, 0.3], payload: {} },
        ])
      ).rejects.toThrow(ValidationError);
    });

    it('should handle points without vector array', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
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
          id: 'point1',
          payload: { category: 'test' },
        } as unknown as Point,
      ];

      await expect(
        client.upsert('test-collection', pointsWithoutVector)
      ).rejects.toThrow(ValidationError);
    });

    it('should handle points with null vector', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
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
          id: 'point1',
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
        .get('/collections/test-collection')
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
          id: 'point1',
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
        .get('/collections/test-collection')
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
      nock('https://vectors.aetherfy.com').get('/collections').reply(500, {
        message: 'Server error',
      });

      await expect(client.getCollections()).rejects.toThrow(
        AetherfyVectorsError
      );
    });

    it('should handle generic network errors', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/collections')
        .replyWithError(new Error('Connection failed'));

      await expect(client.getCollections()).rejects.toThrow(NetworkError);
    });

    it('should handle ECONNABORTED errors', async () => {
      const error = new Error('Connection ECONNABORTED');

      nock('https://vectors.aetherfy.com')
        .get('/collections')
        .replyWithError(error);

      await expect(client.getCollections()).rejects.toThrow(NetworkError);
    });

    it('should handle timeout errors', async () => {
      const error = new Error('Request timeout');

      nock('https://vectors.aetherfy.com')
        .get('/collections')
        .replyWithError(error);

      await expect(client.getCollections()).rejects.toThrow(NetworkError);
    });

    it('should handle upsert errors that are not 500 status', async () => {
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
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
        .put('/collections/test-collection/points')
        .replyWithError(new Error('Database connection failed'));

      await expect(
        client.upsert('test-collection', [
          { id: '1', vector: [0.1, 0.2, 0.3], payload: {} },
        ])
      ).rejects.toThrow(NetworkError);
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
