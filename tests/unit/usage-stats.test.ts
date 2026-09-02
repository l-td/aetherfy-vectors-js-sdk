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

  // A GET /api/v1/analytics/usage body, copied from the wire. THIS IS A COPY
  // OF THE TRUTH, NOT THE TRUTH — the authoritative pin is the live call in
  // aetherfy-e2e-tests tests/sdk/js_usage_stats.test.js, and this mock must
  // only ever be changed together with it. Everything in this file is nocked,
  // so nothing here can tell you the endpoint still serves this shape: that is
  // precisely how UsageStats spent its whole life declaring nine camelCase
  // fields no response has ever carried.
  const mockUsage: UsageStats = {
    storage_bytes_used: 268_435_456,
    storage_limit_bytes: 1_073_741_824,
    collections_count: 5,
    collections_limit: 100,
    tier: 'developer',
    active_regions: ['us-east-1', 'eu-central-1'],
    usage_percentage: 25,
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

  it('does not require or expose a request count', async () => {
    // `requests_this_hour` was deleted from the endpoint in 2026-09 (it read
    // a Redis key nothing had ever written, so every customer was told 0),
    // and `requests_this_month` never existed — it was one of the nine
    // invented fields this type used to declare. A body carrying only the
    // seven real fields must come back whole, and must not answer to either
    // name.
    expect(mockUsage).not.toHaveProperty('requests_this_hour');
    expect(mockUsage).not.toHaveProperty('requests_this_month');

    nock(baseUrl).get('/api/v1/analytics/usage').reply(200, mockUsage);

    const result = await client.getUsageStats();

    expect(result).not.toHaveProperty('requests_this_hour');
    expect(result).not.toHaveProperty('requests_this_month');
  });

  it('carries BOTH unlimited-tier limits through as null', async () => {
    // One sentinel, not two. vectordb's `customerStore` represents "no limit"
    // as the STRING 'unlimited' internally, but that is a limits-vocabulary
    // convention and the endpoint normalises both fields to null before they
    // reach the wire — pinned server-side by vectordb
    // tests/unit/analyticsMetricsRead.test.js, "an unlimited tier reports
    // BOTH limits as null, in one vocabulary".
    //
    // This case previously used `collections_limit: -1`, a payload the
    // backend has never sent. Inventing a sentinel to test against is the
    // exact defect this file exists to close.
    const unlimited: UsageStats = {
      storage_bytes_used: 42,
      storage_limit_bytes: null,
      collections_count: 3,
      collections_limit: null,
      tier: 'enterprise',
      active_regions: [],
      usage_percentage: 0,
    };

    nock(baseUrl).get('/api/v1/analytics/usage').reply(200, unlimited);

    const result = await client.getUsageStats();

    expect(result.storage_limit_bytes).toBeNull();
    expect(result.collections_limit).toBeNull();
    expect(result.active_regions).toEqual([]);
    expect(result.usage_percentage).toBe(0);
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
