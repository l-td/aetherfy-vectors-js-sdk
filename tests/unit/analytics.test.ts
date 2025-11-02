/**
 * Unit tests for AnalyticsClient
 */

import nock from 'nock';

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

describe('AnalyticsClient', () => {
  let client: AnalyticsClient;
  let httpClient: HttpClient;
  const baseUrl = 'https://vectors.aetherfy.com';
  const authHeaders = { Authorization: 'Bearer afy_test_1234567890123456' };

  beforeEach(() => {
    httpClient = new HttpClient({
      defaultHeaders: authHeaders,
      enableConnectionPooling: false,
    });
    client = new AnalyticsClient(httpClient, baseUrl, authHeaders);
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

      nock(baseUrl)
        .get('/analytics/performance?time_range=24h')
        .reply(200, mockAnalytics);

      const result = await client.getPerformanceAnalytics();

      expect(result).toEqual(mockAnalytics);
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

      nock(baseUrl)
        .get('/analytics/performance?time_range=7d')
        .reply(200, mockAnalytics);

      const result = await client.getPerformanceAnalytics('7d');

      expect(result).toEqual(mockAnalytics);
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

      nock(baseUrl)
        .get('/analytics/performance?time_range=24h&region=us-east-1')
        .reply(200, mockAnalytics);

      const result = await client.getPerformanceAnalytics('24h', 'us-east-1');

      expect(result).toEqual(mockAnalytics);
    });

    it('should handle errors properly', async () => {
      nock(baseUrl).get('/analytics/performance?time_range=24h').reply(401, {
        message: 'Authentication failed',
        code: 'AUTH_ERROR',
      });

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

      nock(baseUrl)
        .get('/analytics/collections/products?time_range=24h')
        .reply(200, mockAnalytics);

      const result = await client.getCollectionAnalytics('products');

      expect(result).toEqual(mockAnalytics);
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

      nock(baseUrl)
        .get('/analytics/collections/users?time_range=7d')
        .reply(200, mockAnalytics);

      const result = await client.getCollectionAnalytics('users', '7d');

      expect(result).toEqual(mockAnalytics);
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

      nock(baseUrl)
        .get('/analytics/collections/test%20collection?time_range=24h')
        .reply(200, mockAnalytics);

      const result = await client.getCollectionAnalytics('test collection');

      expect(result).toEqual(mockAnalytics);
    });

    it('should handle not found error for non-existent collection', async () => {
      nock(baseUrl)
        .get('/analytics/collections/non-existent?time_range=24h')
        .reply(404, {
          message: 'Collection not found',
          code: 'COLLECTION_NOT_FOUND',
        });

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

      nock(baseUrl).get('/analytics/usage').reply(200, mockUsage);

      const result = await client.getUsageStats();

      expect(result).toEqual(mockUsage);
    });

    it('should handle errors properly', async () => {
      nock(baseUrl).get('/analytics/usage').reply(429, {
        message: 'Too many requests',
        code: 'RATE_LIMIT_EXCEEDED',
      });

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

      nock(baseUrl)
        .get('/analytics/regions?time_range=24h')
        .reply(200, mockRegions);

      const result = await client.getRegionPerformance();

      expect(result).toEqual(mockRegions.regions);
    });

    it('should get regional performance with custom time range', async () => {
      const mockRegions = {
        regions: {
          'ap-southeast-1': { avgLatencyMs: 60, requestsPerSecond: 200 },
        },
      };

      nock(baseUrl)
        .get('/analytics/regions?time_range=7d')
        .reply(200, mockRegions);

      const result = await client.getRegionPerformance('7d');

      expect(result).toEqual(mockRegions.regions);
    });

    it('should return empty object if regions are missing', async () => {
      nock(baseUrl).get('/analytics/regions?time_range=24h').reply(200, {});

      const result = await client.getRegionPerformance();

      expect(result).toEqual({});
    });

    it('should handle errors properly', async () => {
      nock(baseUrl).get('/analytics/regions?time_range=24h').reply(500, {
        message: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });

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

      nock(baseUrl)
        .get('/analytics/cache?time_range=24h')
        .reply(200, mockCacheStats);

      const result = await client.getCacheAnalytics();

      expect(result).toEqual(mockCacheStats);
    });

    it('should get cache analytics with custom time range', async () => {
      const mockCacheStats: CacheStats = {
        hitRate: 88.0,
        hits: 44000,
        misses: 6000,
      };

      nock(baseUrl)
        .get('/analytics/cache?time_range=30d')
        .reply(200, mockCacheStats);

      const result = await client.getCacheAnalytics('30d');

      expect(result).toEqual(mockCacheStats);
    });

    it('should handle errors properly', async () => {
      nock(baseUrl).get('/analytics/cache?time_range=24h').reply(403, {
        message: 'Forbidden',
        code: 'FORBIDDEN',
      });

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

      nock(baseUrl)
        .get(
          '/analytics/collections/top?metric=requests&time_range=24h&limit=10'
        )
        .reply(200, { collections: mockCollections });

      const result = await client.getTopCollections();

      expect(result).toEqual(mockCollections);
    });

    it('should get top collections with custom parameters', async () => {
      const mockCollections: TopCollectionEntry[] = [
        { collectionName: 'large-dataset', value: 1000000 },
        { collectionName: 'medium-dataset', value: 500000 },
      ];

      nock(baseUrl)
        .get('/analytics/collections/top?metric=points&time_range=7d&limit=5')
        .reply(200, { collections: mockCollections });

      const result = await client.getTopCollections('points', '7d', 5);

      expect(result).toEqual(mockCollections);
    });

    it('should return empty array if collections are missing', async () => {
      nock(baseUrl)
        .get(
          '/analytics/collections/top?metric=requests&time_range=24h&limit=10'
        )
        .reply(200, {});

      const result = await client.getTopCollections();

      expect(result).toEqual([]);
    });

    it('should handle errors properly', async () => {
      nock(baseUrl)
        .get(
          '/analytics/collections/top?metric=requests&time_range=24h&limit=10'
        )
        .reply(400, {
          message: 'Bad request',
          code: 'VALIDATION_ERROR',
        });

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

      nock(baseUrl)
        .get('/analytics/regions/info')
        .reply(200, { regions: mockRegions });

      const result = await client.getRegions();

      expect(result).toEqual(mockRegions);
    });

    it('should return empty array if regions are missing', async () => {
      nock(baseUrl).get('/analytics/regions/info').reply(200, {});

      const result = await client.getRegions();

      expect(result).toEqual([]);
    });

    it('should handle errors properly', async () => {
      nock(baseUrl).get('/analytics/regions/info').reply(503, {
        message: 'Service unavailable',
        code: 'SERVICE_UNAVAILABLE',
      });

      await expect(client.getRegions()).rejects.toThrow();
    });
  });

  describe('handleError', () => {
    it('should convert HTTP errors to appropriate exception types', async () => {
      nock(baseUrl).get('/analytics/performance?time_range=24h').reply(401, {
        message: 'Invalid API key',
        code: 'INVALID_API_KEY',
      });

      await expect(client.getPerformanceAnalytics()).rejects.toThrow(
        AuthenticationError
      );
    });

    it('should handle non-HTTP errors', async () => {
      nock(baseUrl)
        .get('/analytics/performance?time_range=24h')
        .replyWithError(new Error('Network Error'));

      await expect(client.getPerformanceAnalytics()).rejects.toThrow();
    });

    it('should handle unknown errors', async () => {
      const error = new Error('timeout');
      Object.assign(error, { code: 'ECONNABORTED' });

      nock(baseUrl)
        .get('/analytics/performance?time_range=24h')
        .replyWithError(error);

      await expect(client.getPerformanceAnalytics()).rejects.toThrow();
    });
  });
});
