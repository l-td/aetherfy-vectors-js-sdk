/**
 * Unit tests for AetherfyVectorsClient
 */

import { AetherfyVectorsClient } from '../../src/client';
import { DistanceMetric } from '../../src/models';
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
});
