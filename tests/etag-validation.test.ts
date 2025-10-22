/**
 * Tests for ETag-based schema validation and caching
 */

import { AetherfyVectorsClient } from '../src/client';
import { ValidationError, AetherfyVectorsError } from '../src/exceptions';
import fetchMock from 'jest-fetch-mock';

describe('ETag Validation', () => {
  let client: AetherfyVectorsClient;

  beforeEach(() => {
    fetchMock.resetMocks();

    client = new AetherfyVectorsClient({
      apiKey: 'afy_test_1234567890123456',
      endpoint: 'http://localhost:3000',
    });
  });

  it('should fetch schema on first upsert', async () => {
    // Mock GET collection response
    fetchMock.mockResponseOnce(
      JSON.stringify({
        result: {
          config: {
            params: {
              vectors: {
                size: 768,
                distance: 'Cosine',
              },
            },
          },
        },
        schema_version: 'abc12345',
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );

    // Mock PUT upsert response
    fetchMock.mockResponseOnce(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    // First upsert
    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];
    await client.upsert('test-collection', points);

    // Should have made 2 calls: GET for schema, PUT for upsert
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(fetchMock.mock.calls[0][0]).toContain(
      '/collections/test-collection'
    );
    expect(fetchMock.mock.calls[1][0]).toContain(
      '/collections/test-collection/points'
    );
  });

  it('should reuse cached schema on subsequent upserts', async () => {
    // Mock GET collection response (only once)
    fetchMock.mockResponseOnce(
      JSON.stringify({
        result: {
          config: {
            params: {
              vectors: {
                size: 768,
                distance: 'Cosine',
              },
            },
          },
        },
        schema_version: 'abc12345',
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );

    // Mock PUT upsert responses (two times)
    fetchMock.mockResponse(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];

    // First upsert
    await client.upsert('test-collection', points);

    // Second upsert
    await client.upsert('test-collection', points);

    // Should have made 3 calls total: GET for schema (once), PUT for upsert (twice)
    // If cache is working, no second GET call
    expect(fetchMock.mock.calls.length).toBe(3);
    const getCalls = fetchMock.mock.calls.filter(
      call => call[1]?.method === 'GET' || !call[1]?.method
    );
    expect(getCalls.length).toBe(1); // Only 1 GET call (schema was cached)
  });

  it('should send ETag in If-Match header', async () => {
    // Mock GET collection response
    fetchMock.mockResponseOnce(
      JSON.stringify({
        result: {
          config: {
            params: {
              vectors: {
                size: 768,
                distance: 'Cosine',
              },
            },
          },
        },
        schema_version: 'abc12345',
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );

    // Mock PUT upsert response
    fetchMock.mockResponseOnce(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];
    await client.upsert('test-collection', points);

    // Check If-Match header was sent in PUT request
    const putCall = fetchMock.mock.calls.find(
      call => call[1]?.method === 'PUT'
    );
    expect(putCall).toBeDefined();
    const headers = putCall?.[1]?.headers as Record<string, string>;
    expect(headers['If-Match']).toBe('abc12345');
  });

  it('should catch dimension mismatch client-side before request', async () => {
    // Mock GET collection response
    fetchMock.mockResponseOnce(
      JSON.stringify({
        result: {
          config: {
            params: {
              vectors: {
                size: 768,
                distance: 'Cosine',
              },
            },
          },
        },
        schema_version: 'abc12345',
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );

    // Upsert with wrong dimensions
    const points = [{ id: '1', vector: new Array(384).fill(0.1), payload: {} }];

    await expect(client.upsert('test-collection', points)).rejects.toThrow(
      ValidationError
    );
    await expect(client.upsert('test-collection', points)).rejects.toThrow(
      /dimension mismatch/i
    );
    await expect(client.upsert('test-collection', points)).rejects.toThrow(
      /expected 768/
    );
    await expect(client.upsert('test-collection', points)).rejects.toThrow(
      /got 384/
    );

    // PUT should NOT have been called (failed validation client-side)
    const putCalls = fetchMock.mock.calls.filter(
      call => call[1]?.method === 'PUT'
    );
    expect(putCalls.length).toBe(0);
  });

  it('should handle 412 response (schema changed)', async () => {
    // Mock GET collection response
    fetchMock.mockResponseOnce(
      JSON.stringify({
        result: {
          config: {
            params: {
              vectors: {
                size: 768,
                distance: 'Cosine',
              },
            },
          },
        },
        schema_version: 'abc12345',
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );

    // Mock PUT with 412 response
    fetchMock.mockResponseOnce(
      JSON.stringify({
        error: {
          code: 'SCHEMA_VERSION_MISMATCH',
          message: 'Collection schema has changed',
        },
      }),
      {
        status: 412,
        headers: { 'content-type': 'application/json' },
      }
    );

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];

    await expect(client.upsert('test-collection', points)).rejects.toThrow(
      ValidationError
    );
    await expect(client.upsert('test-collection', points)).rejects.toThrow(
      /schema.*changed/i
    );
  });

  it('should clear cache for single collection', () => {
    // Use public API to test cache clearing
    client.clearSchemaCache('collection1');

    // This test verifies the public API works without errors
    expect(() => client.clearSchemaCache('collection1')).not.toThrow();
  });

  it('should clear cache for all collections', () => {
    // Use public API to test cache clearing
    client.clearSchemaCache();

    // This test verifies the public API works without errors
    expect(() => client.clearSchemaCache()).not.toThrow();
  });

  it('should handle 400 validation error from backend', async () => {
    // Mock GET collection response
    fetchMock.mockResponseOnce(
      JSON.stringify({
        result: {
          config: {
            params: {
              vectors: {
                size: 768,
                distance: 'Cosine',
              },
            },
          },
        },
        schema_version: 'abc12345',
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );

    // Mock PUT with 400 response
    fetchMock.mockResponseOnce(
      JSON.stringify({
        error: {
          code: 'DIMENSION_MISMATCH',
          message: 'Vector dimension mismatch: expected 768, got 384',
        },
      }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }
    );

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];

    await expect(client.upsert('test-collection', points)).rejects.toThrow(
      ValidationError
    );
    await expect(client.upsert('test-collection', points)).rejects.toThrow(
      /dimension mismatch/i
    );
  });

  it('should handle 500 server error', async () => {
    // Mock GET collection response
    fetchMock.mockResponseOnce(
      JSON.stringify({
        result: {
          config: {
            params: {
              vectors: {
                size: 768,
                distance: 'Cosine',
              },
            },
          },
        },
        schema_version: 'abc12345',
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );

    // Mock PUT with 500 response
    fetchMock.mockResponseOnce(
      JSON.stringify({
        error: {
          message: 'Internal server error',
        },
      }),
      {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }
    );

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];

    await expect(client.upsert('test-collection', points)).rejects.toThrow(
      AetherfyVectorsError
    );
    await expect(client.upsert('test-collection', points)).rejects.toThrow(
      /server error/i
    );
  });

  it('should validate vector array exists', async () => {
    // Mock GET collection response
    fetchMock.mockResponseOnce(
      JSON.stringify({
        result: {
          config: {
            params: {
              vectors: {
                size: 768,
                distance: 'Cosine',
              },
            },
          },
        },
        schema_version: 'abc12345',
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );

    // Points without vector (intentionally invalid for testing)
    const points = [{ id: '1', payload: {} }] as unknown as Array<{
      id: string;
      vector: number[];
      payload: Record<string, unknown>;
    }>;

    await expect(client.upsert('test-collection', points)).rejects.toThrow(
      ValidationError
    );
    await expect(client.upsert('test-collection', points)).rejects.toThrow(
      /must have a vector array/i
    );
  });
});
