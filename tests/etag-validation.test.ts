/**
 * Tests for ETag-based schema validation and caching
 */

import { AetherfyVectorsClient } from '../src/client';
import { ValidationError, AetherfyVectorsError } from '../src/exceptions';

// Mock HTTP client
jest.mock('../src/http/client');

describe('ETag Validation', () => {
  let client: AetherfyVectorsClient;
  let mockHttpClient: any;

  const mockCollectionResponse = {
    data: {
      result: {
        config: {
          params: {
            vectors: {
              size: 768,
              distance: 'Cosine'
            }
          }
        }
      },
      schema_version: 'abc12345'
    }
  };

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    client = new AetherfyVectorsClient({
      apiKey: 'test_key',
      endpoint: 'http://localhost:3000'
    });

    // Access private httpClient for mocking
    mockHttpClient = (client as any).httpClient;
  });

  test('should fetch and cache schema on first upsert', async () => {
    // Mock GET collection response
    mockHttpClient.get = jest.fn().mockResolvedValue(mockCollectionResponse);

    // Mock PUT upsert response
    mockHttpClient.put = jest.fn().mockResolvedValue({
      status: 200,
      data: { success: true }
    });

    // First upsert
    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];
    await client.upsert('test-collection', points);

    // Should have called GET to fetch schema
    expect(mockHttpClient.get).toHaveBeenCalled();

    // Should have cached the schema
    const schema = (client as any).schemaCache.get('test-collection');
    expect(schema).toBeDefined();
    expect(schema.size).toBe(768);
    expect(schema.etag).toBe('abc12345');
  });

  test('should reuse cached schema on subsequent upserts', async () => {
    // Mock GET collection response
    mockHttpClient.get = jest.fn().mockResolvedValue(mockCollectionResponse);

    // Mock PUT upsert response
    mockHttpClient.put = jest.fn().mockResolvedValue({
      status: 200,
      data: { success: true }
    });

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];

    // First upsert
    await client.upsert('test-collection', points);
    const getCallCountAfterFirst = mockHttpClient.get.mock.calls.length;

    // Second upsert
    await client.upsert('test-collection', points);

    // GET should not be called again (cache hit)
    expect(mockHttpClient.get.mock.calls.length).toBe(getCallCountAfterFirst);
  });

  test('should send ETag in If-Match header', async () => {
    // Mock GET collection response
    mockHttpClient.get = jest.fn().mockResolvedValue(mockCollectionResponse);

    // Mock PUT upsert response
    mockHttpClient.put = jest.fn().mockResolvedValue({
      status: 200,
      data: { success: true }
    });

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];
    await client.upsert('test-collection', points);

    // Check If-Match header was sent
    const putCall = mockHttpClient.put.mock.calls[0];
    const options = putCall[2]; // Third argument is options
    expect(options.headers['If-Match']).toBe('abc12345');
  });

  test('should catch dimension mismatch client-side before request', async () => {
    // Mock GET collection response
    mockHttpClient.get = jest.fn().mockResolvedValue(mockCollectionResponse);

    // Mock PUT (should not be called)
    mockHttpClient.put = jest.fn();

    // Upsert with wrong dimensions
    const points = [{ id: '1', vector: new Array(384).fill(0.1), payload: {} }];

    await expect(client.upsert('test-collection', points)).rejects.toThrow(ValidationError);
    await expect(client.upsert('test-collection', points)).rejects.toThrow(/dimension mismatch/i);
    await expect(client.upsert('test-collection', points)).rejects.toThrow(/expected 768/);
    await expect(client.upsert('test-collection', points)).rejects.toThrow(/got 384/);

    // PUT should NOT have been called (failed validation client-side)
    expect(mockHttpClient.put).not.toHaveBeenCalled();
  });

  test('should handle 412 response (schema changed)', async () => {
    // Mock GET collection response
    mockHttpClient.get = jest.fn().mockResolvedValue(mockCollectionResponse);

    // Mock PUT with 412 response
    mockHttpClient.put = jest.fn().mockRejectedValue({
      response: {
        status: 412,
        data: {
          error: {
            code: 'SCHEMA_VERSION_MISMATCH',
            message: 'Collection schema has changed'
          }
        }
      }
    });

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];

    await expect(client.upsert('test-collection', points)).rejects.toThrow(ValidationError);
    await expect(client.upsert('test-collection', points)).rejects.toThrow(/schema.*changed/i);

    // Cache should be cleared
    const schema = (client as any).schemaCache.get('test-collection');
    expect(schema).toBeUndefined();
  });

  test('should clear cache for single collection', () => {
    // Populate cache
    (client as any).schemaCache.set('collection1', { size: 768, etag: 'abc' });
    (client as any).schemaCache.set('collection2', { size: 384, etag: 'def' });

    // Clear one collection
    client.clearSchemaCache('collection1');

    // collection1 should be cleared
    expect((client as any).schemaCache.has('collection1')).toBe(false);
    // collection2 should remain
    expect((client as any).schemaCache.has('collection2')).toBe(true);
  });

  test('should clear cache for all collections', () => {
    // Populate cache
    (client as any).schemaCache.set('collection1', { size: 768, etag: 'abc' });
    (client as any).schemaCache.set('collection2', { size: 384, etag: 'def' });

    // Clear all
    client.clearSchemaCache();

    // Both should be cleared
    expect((client as any).schemaCache.size).toBe(0);
  });

  test('should handle 400 validation error from backend', async () => {
    // Mock GET collection response
    mockHttpClient.get = jest.fn().mockResolvedValue(mockCollectionResponse);

    // Mock PUT with 400 response
    mockHttpClient.put = jest.fn().mockRejectedValue({
      response: {
        status: 400,
        data: {
          error: {
            code: 'DIMENSION_MISMATCH',
            message: 'Vector dimension mismatch: expected 768, got 384'
          }
        }
      }
    });

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];

    await expect(client.upsert('test-collection', points)).rejects.toThrow(ValidationError);
    await expect(client.upsert('test-collection', points)).rejects.toThrow(/dimension mismatch/i);
  });

  test('should handle 500 server error', async () => {
    // Mock GET collection response
    mockHttpClient.get = jest.fn().mockResolvedValue(mockCollectionResponse);

    // Mock PUT with 500 response
    mockHttpClient.put = jest.fn().mockRejectedValue({
      response: {
        status: 500,
        data: {
          error: {
            message: 'Internal server error'
          }
        }
      }
    });

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];

    await expect(client.upsert('test-collection', points)).rejects.toThrow(AetherfyVectorsError);
    await expect(client.upsert('test-collection', points)).rejects.toThrow(/server error/i);
  });

  test('should validate vector array exists', async () => {
    // Mock GET collection response
    mockHttpClient.get = jest.fn().mockResolvedValue(mockCollectionResponse);

    // Points without vector
    const points = [{ id: '1', payload: {} }] as any;

    await expect(client.upsert('test-collection', points)).rejects.toThrow(ValidationError);
    await expect(client.upsert('test-collection', points)).rejects.toThrow(/must have a vector array/i);
  });
});
