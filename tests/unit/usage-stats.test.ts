/**
 * Unit tests for usage statistics — the one surviving analytics surface.
 *
 * This file is what remains of analytics.test.ts. AnalyticsClient was deleted
 * along with every method it carried except this one: getPerformanceAnalytics
 * reported a regionPerformance the backend synthesised rather than measured,
 * and getRegionPerformance / getCacheAnalytics / getRegions called routes that
 * do not exist. `GET /api/v1/analytics/usage` is the only analytics endpoint
 * backed by real data (the backend reads Postgres for it), so it is the only
 * one that survived.
 *
 * The receiver moved with the code: these tests used to construct an
 * AnalyticsClient directly, and the method now lives on AetherfyVectorsClient.
 * The error-shape coverage that used to run through getPerformanceAnalytics is
 * re-pointed here, so the mapping from HTTP status to exception type is still
 * exercised rather than deleted along with its old carrier.
 */

import nock from 'nock';

import { AetherfyVectorsClient } from '../../src/client';
import { UsageStats } from '../../src/models';
import {
  AuthenticationError,
  RateLimitExceededError,
} from '../../src/exceptions';

describe('getUsageStats', () => {
  let client: AetherfyVectorsClient;
  const baseUrl = 'https://vectors.aetherfy.com';

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

  beforeEach(() => {
    client = new AetherfyVectorsClient({
      apiKey: 'afy_test_1234567890123456',
      enableConnectionPooling: false,
    });
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('gets account usage statistics', async () => {
    const scope = nock(baseUrl)
      .get('/api/v1/analytics/usage')
      .reply(200, mockUsage);

    const result = await client.getUsageStats();

    expect(result).toEqual(mockUsage);
    // The path is pinned, not just the payload: this is the contract the
    // backend keeps serving now that every sibling endpoint is gone.
    expect(scope.isDone()).toBe(true);
  });

  it('maps a 429 to RateLimitExceededError', async () => {
    nock(baseUrl).get('/api/v1/analytics/usage').reply(429, {
      message: 'Too many requests',
      code: 'RATE_LIMIT_EXCEEDED',
    });

    await expect(client.getUsageStats()).rejects.toThrow(
      RateLimitExceededError
    );
  });

  it('maps a 401 to AuthenticationError', async () => {
    nock(baseUrl).get('/api/v1/analytics/usage').reply(401, {
      message: 'Invalid API key',
      code: 'INVALID_API_KEY',
    });

    await expect(client.getUsageStats()).rejects.toThrow(AuthenticationError);
  });

  it('surfaces a transport error rather than swallowing it', async () => {
    nock(baseUrl)
      .get('/api/v1/analytics/usage')
      .replyWithError(new Error('Network Error'));

    await expect(client.getUsageStats()).rejects.toThrow();
  });

  it('surfaces a timeout-shaped error', async () => {
    const error = new Error('timeout');
    Object.assign(error, { code: 'ECONNABORTED' });

    nock(baseUrl).get('/api/v1/analytics/usage').replyWithError(error);

    await expect(client.getUsageStats()).rejects.toThrow();
  });
});
