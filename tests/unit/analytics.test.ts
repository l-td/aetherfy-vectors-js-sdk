/**
 * Unit tests for AnalyticsClient
 */

import { AnalyticsClient } from '../../src/analytics';
import { HttpClient } from '../../src/http/client';
import {
  PerformanceAnalytics,
  CollectionAnalytics,
  UsageStats,
  CacheStats,
  RegionInfo,
  TopCollectionEntry,
} from '../../src/models';
import {
  ValidationError,
  AuthenticationError,
  RateLimitExceededError,
} from '../../src/exceptions';
import fetchMock from 'jest-fetch-mock';

describe('AnalyticsClient', () => {
  let client: AnalyticsClient;
  let httpClient: HttpClient;
  const baseUrl = 'https://vectors.aetherfy.com';
  const authHeaders = { Authorization: 'Bearer afy_test_1234567890123456' };

  beforeEach(() => {
    fetchMock.resetMocks();
    httpClient = new HttpClient({
      defaultHeaders: authHeaders,
    });
    client = new AnalyticsClient(httpClient, baseUrl, authHeaders);
  });

  afterAll(() => {
    fetchMock.disableMocks();
  });

  describe('getPerformanceAnalytics', () => {
    it('should get performance analytics with default time range', async () => {
      const mockAnalytics: PerformanceAnalytics = {
        cacheHitRate: 94.2,
        avgLatencyMs: 45,
        requestsPerSecond: 1250,
        activeRegions: ['us-east-1', 'eu-west-1'],
        regionPerformance: {
          'us-east-1': { avgLatencyMs: 40, requestsPerSecond: 700 },
          'eu-west-1': { avgLatencyMs: 50, requestsPerSecond: 550 },
        },
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockAnalytics), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getPerformanceAnalytics();

      expect(result).toEqual(mockAnalytics);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/performance?time_range=24h`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer afy_test_1234567890123456',
          }),
        })
      );
    });

    it('should get performance analytics with custom time range', async () => {
      const mockAnalytics: PerformanceAnalytics = {
        cacheHitRate: 92.1,
        avgLatencyMs: 50,
        requestsPerSecond: 1100,
        activeRegions: ['us-east-1'],
        regionPerformance: {
          'us-east-1': { avgLatencyMs: 50, requestsPerSecond: 1100 },
        },
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockAnalytics), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getPerformanceAnalytics('7d');

      expect(result).toEqual(mockAnalytics);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/performance?time_range=7d`,
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('should get performance analytics for specific region', async () => {
      const mockAnalytics: PerformanceAnalytics = {
        cacheHitRate: 95.0,
        avgLatencyMs: 40,
        requestsPerSecond: 800,
        activeRegions: ['us-east-1'],
        regionPerformance: {
          'us-east-1': { avgLatencyMs: 40, requestsPerSecond: 800 },
        },
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockAnalytics), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getPerformanceAnalytics('24h', 'us-east-1');

      expect(result).toEqual(mockAnalytics);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/performance?time_range=24h&region=us-east-1`,
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('should handle errors properly', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'Authentication failed',
            code: 'AUTH_ERROR',
          }),
          {
            status: 401,
            statusText: 'Unauthorized',
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      await expect(client.getPerformanceAnalytics()).rejects.toThrow(
        AuthenticationError
      );
    });
  });

  describe('getCollectionAnalytics', () => {
    it('should get analytics for specific collection with default time range', async () => {
      const mockAnalytics: CollectionAnalytics = {
        collectionName: 'products',
        totalPoints: 50000,
        searchRequests: 12000,
        avgSearchLatencyMs: 35,
        cacheHitRate: 90.5,
        topRegions: ['us-east-1', 'eu-west-1'],
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockAnalytics), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getCollectionAnalytics('products');

      expect(result).toEqual(mockAnalytics);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/collections/products?time_range=24h`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer afy_test_1234567890123456',
          }),
        })
      );
    });

    it('should get analytics for specific collection with custom time range', async () => {
      const mockAnalytics: CollectionAnalytics = {
        collectionName: 'users',
        totalPoints: 100000,
        searchRequests: 25000,
        avgSearchLatencyMs: 40,
        cacheHitRate: 88.0,
        topRegions: ['us-east-1'],
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockAnalytics), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getCollectionAnalytics('users', '7d');

      expect(result).toEqual(mockAnalytics);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/collections/users?time_range=7d`,
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('should properly encode collection name', async () => {
      const mockAnalytics: CollectionAnalytics = {
        collectionName: 'test collection',
        totalPoints: 1000,
        searchRequests: 500,
        avgSearchLatencyMs: 30,
        cacheHitRate: 85.0,
        topRegions: ['us-east-1'],
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockAnalytics), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getCollectionAnalytics('test collection');

      expect(result).toEqual(mockAnalytics);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/collections/test%20collection?time_range=24h`,
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('should handle not found error for non-existent collection', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'Collection not found',
            code: 'COLLECTION_NOT_FOUND',
          }),
          {
            status: 404,
            statusText: 'Not Found',
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      await expect(
        client.getCollectionAnalytics('non-existent')
      ).rejects.toThrow();
    });
  });

  describe('getUsageStats', () => {
    it('should get account usage statistics', async () => {
      const mockUsage: UsageStats = {
        currentCollections: 5,
        maxCollections: 100,
        currentPoints: 50000,
        maxPoints: 1000000,
        requestsThisMonth: 125000,
        maxRequestsPerMonth: 1000000,
        storageUsedMb: 250,
        maxStorageMb: 10000,
        planName: 'Developer',
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockUsage), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getUsageStats();

      expect(result).toEqual(mockUsage);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/usage`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer afy_test_1234567890123456',
          }),
        })
      );
    });

    it('should handle errors properly', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'Too many requests',
            code: 'RATE_LIMIT_EXCEEDED',
          }),
          {
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      await expect(client.getUsageStats()).rejects.toThrow(
        RateLimitExceededError
      );
    });
  });

  describe('getRegionPerformance', () => {
    it('should get regional performance with default time range', async () => {
      const mockRegions = {
        regions: {
          'us-east-1': { avgLatencyMs: 40, requestsPerSecond: 500 },
          'eu-west-1': { avgLatencyMs: 45, requestsPerSecond: 350 },
        },
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockRegions), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getRegionPerformance();

      expect(result).toEqual(mockRegions.regions);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/regions?time_range=24h`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer afy_test_1234567890123456',
          }),
        })
      );
    });

    it('should get regional performance with custom time range', async () => {
      const mockRegions = {
        regions: {
          'ap-southeast-1': { avgLatencyMs: 60, requestsPerSecond: 200 },
        },
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockRegions), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getRegionPerformance('7d');

      expect(result).toEqual(mockRegions.regions);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/regions?time_range=7d`,
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('should return empty object if regions are missing', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getRegionPerformance();

      expect(result).toEqual({});
    });

    it('should handle errors properly', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'Internal server error',
            code: 'INTERNAL_ERROR',
          }),
          {
            status: 500,
            statusText: 'Internal Server Error',
            headers: { 'content-type': 'application/json' },
          }
        )
      );

      await expect(client.getRegionPerformance()).rejects.toThrow();
    });
  });

  describe('getCacheAnalytics', () => {
    it('should get cache analytics with default time range', async () => {
      const mockCacheStats: CacheStats = {
        hitRate: 92.5,
        hits: 9250,
        misses: 750,
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockCacheStats), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getCacheAnalytics();

      expect(result).toEqual(mockCacheStats);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/cache?time_range=24h`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer afy_test_1234567890123456',
          }),
        })
      );
    });

    it('should get cache analytics with custom time range', async () => {
      const mockCacheStats: CacheStats = {
        hitRate: 88.0,
        hits: 44000,
        misses: 6000,
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(mockCacheStats), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getCacheAnalytics('30d');

      expect(result).toEqual(mockCacheStats);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/cache?time_range=30d`,
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('should handle errors properly', async () => {
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

      await expect(client.getCacheAnalytics()).rejects.toThrow();
    });
  });

  describe('getTopCollections', () => {
    it('should get top collections with default parameters', async () => {
      const mockCollections: TopCollectionEntry[] = [
        { collectionName: 'products', value: 15000 },
        { collectionName: 'users', value: 12000 },
        { collectionName: 'documents', value: 8000 },
      ];

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ collections: mockCollections }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getTopCollections();

      expect(result).toEqual(mockCollections);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/collections/top?metric=requests&time_range=24h&limit=10`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer afy_test_1234567890123456',
          }),
        })
      );
    });

    it('should get top collections with custom parameters', async () => {
      const mockCollections: TopCollectionEntry[] = [
        { collectionName: 'large-dataset', value: 1000000 },
        { collectionName: 'medium-dataset', value: 500000 },
      ];

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ collections: mockCollections }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getTopCollections('points', '7d', 5);

      expect(result).toEqual(mockCollections);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/collections/top?metric=points&time_range=7d&limit=5`,
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('should return empty array if collections are missing', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getTopCollections();

      expect(result).toEqual([]);
    });

    it('should handle errors properly', async () => {
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

      await expect(client.getTopCollections()).rejects.toThrow(ValidationError);
    });
  });

  describe('getRegions', () => {
    it('should get available regions', async () => {
      const mockRegions: RegionInfo[] = [
        {
          id: 'us-east-1',
          name: 'US East (N. Virginia)',
          active: true,
          latencyMs: 40,
        },
        {
          id: 'eu-west-1',
          name: 'EU West (Ireland)',
          active: true,
          latencyMs: 45,
        },
        {
          id: 'ap-southeast-1',
          name: 'Asia Pacific (Singapore)',
          active: true,
          latencyMs: 60,
        },
      ];

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ regions: mockRegions }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getRegions();

      expect(result).toEqual(mockRegions);
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/analytics/regions/info`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer afy_test_1234567890123456',
          }),
        })
      );
    });

    it('should return empty array if regions are missing', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        })
      );

      const result = await client.getRegions();

      expect(result).toEqual([]);
    });

    it('should handle errors properly', async () => {
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

      await expect(client.getRegions()).rejects.toThrow();
    });
  });

  describe('handleError', () => {
    it('should convert HTTP errors to appropriate exception types', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: 'Invalid API key',
            code: 'INVALID_API_KEY',
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

      await expect(client.getPerformanceAnalytics()).rejects.toThrow(
        AuthenticationError
      );
    });

    it('should handle non-HTTP errors', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network connection failed'));

      await expect(client.getPerformanceAnalytics()).rejects.toThrow(
        'Network connection failed'
      );
    });

    it('should handle unknown errors', async () => {
      fetchMock.mockRejectedValueOnce('Unknown error string');

      await expect(client.getPerformanceAnalytics()).rejects.toThrow();
    });
  });
});
