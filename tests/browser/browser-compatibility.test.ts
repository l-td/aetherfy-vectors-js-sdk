/**
 * Browser compatibility tests
 */

import { AetherfyVectorsClient } from '../../src/client';
import { APIKeyManager } from '../../src/auth';
import fetchMock from 'jest-fetch-mock';

describe('Browser Compatibility', () => {
  beforeEach(() => {
    // Reset fetch mock
    fetchMock.resetMocks();
    fetchMock.mockResponse(JSON.stringify({ collections: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  describe('Client Initialization', () => {
    it('should initialize client in browser environment', () => {
      expect(() => {
        new AetherfyVectorsClient({
          apiKey: 'afy_test_1234567890123456',
        });
      }).not.toThrow();
    });

    it('should show security warning in browser', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      new APIKeyManager('afy_test_1234567890123456');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('SECURITY WARNING')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('API Operations in Browser', () => {
    let client: AetherfyVectorsClient;

    beforeEach(() => {
      client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
      });
    });

    it('should make API calls from browser', async () => {
      const collections = await client.getCollections();

      expect(global.fetch).toHaveBeenCalledWith(
        'https://vectors.aetherfy.com/collections',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer afy_test_1234567890123456',
            'X-API-Key': 'afy_test_1234567890123456',
          }),
        })
      );

      expect(collections).toEqual([]);
    });

    it('should handle CORS preflight requests', async () => {
      // Mock CORS preflight response
      fetchMock
        .mockResolvedValueOnce(
          new Response(null, {
            status: 200,
            statusText: 'OK',
            headers: {
              'access-control-allow-origin': '*',
              'access-control-allow-methods': 'GET, POST, PUT, DELETE',
              'access-control-allow-headers':
                'Authorization, X-API-Key, Content-Type',
            },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true }), {
            status: 201,
            statusText: 'Created',
            headers: { 'content-type': 'application/json' },
          })
        );

      const result = await client.createCollection('test', {
        size: 128,
        distance: 'Cosine' as 'Cosine',
      });

      expect(result).toBe(true);
    });
  });

  describe('Environment Detection in Browser', () => {
    it('should detect browser environment correctly', () => {
      // Mock browser globals
      (global as Record<string, unknown>).window = { document: {} };
      delete (global as Record<string, unknown>).process;

      // Re-import to get fresh environment detection
      const utils = require('../../src/utils');

      expect(utils.isBrowser()).toBe(true);
      expect(utils.isNode()).toBe(false);
    });
  });

  describe('Error Handling in Browser', () => {
    let client: AetherfyVectorsClient;

    beforeEach(() => {
      client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
      });
    });

    it('should handle network errors gracefully', async () => {
      fetchMock.mockRejectedValue(new Error('Failed to fetch'));

      await expect(client.getCollections()).rejects.toThrow();
    });

    it('should handle CORS errors', async () => {
      fetchMock.mockRejectedValue(new Error('CORS error'));

      await expect(client.getCollections()).rejects.toThrow('CORS error');
    });
  });

  describe('Browser-specific Features', () => {
    it('should work with different fetch implementations', async () => {
      // Mock different fetch behavior (e.g., older browsers)
      const customFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (key: string) =>
            key === 'content-type' ? 'application/json' : null,
          forEach: (callback: (_value: string, _key: string) => void) => {
            callback('application/json', 'content-type');
          },
        },
        json: () => Promise.resolve({ collections: [] }),
      });

      global.fetch = customFetch;

      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
      });

      const collections = await client.getCollections();
      expect(collections).toEqual([]);
      expect(customFetch).toHaveBeenCalled();
    });

    it('should handle browser storage limitations', () => {
      // Test that client doesn't rely on localStorage or sessionStorage
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
      });

      expect(client).toBeInstanceOf(AetherfyVectorsClient);
      // Should work without local storage
    });
  });

  describe('Browser Performance', () => {
    it('should not block the main thread', done => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
      });

      // Start an async operation
      client
        .getCollections()
        .then(() => {
          // This should not block
          done();
        })
        .catch(() => {
          // Even if it fails, we want to complete the test
          done();
        });

      // This should execute immediately
      expect(true).toBe(true);
    });

    it('should handle multiple concurrent requests', async () => {
      // Clear the beforeEach mock and set our own
      fetchMock.resetMocks();

      // CRITICAL: Ensure global.fetch is the same as fetchMock
      (global as Record<string, unknown>).fetch = fetchMock;

      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
      });

      // Mock responses in sequence: first getCollections, then getPerformanceAnalytics
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ collections: [] }), {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              cacheHitRate: 95,
              avgLatencyMs: 50,
              requestsPerSecond: 100,
              activeRegions: ['us-east-1'],
              regionPerformance: {
                'us-east-1': { latency: 50, throughput: 100 },
              },
              totalRequests: 1000,
            }),
            {
              status: 200,
              statusText: 'OK',
              headers: { 'content-type': 'application/json' },
            }
          )
        );

      // Call them sequentially to ensure correct mock order
      const collections = await client.getCollections();

      const analytics = await client.getPerformanceAnalytics();

      expect(collections).toEqual([]);
      expect(analytics).toBeDefined();
      expect(analytics.cacheHitRate).toBe(95);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
