/**
 * Tests for ETag-based schema validation and caching
 */

/// <reference path="../global.d.ts" />

import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { ValidationError, AetherfyVectorsError } from '../../src/exceptions';

describe('ETag Validation', () => {
  let client: AetherfyVectorsClient;

  beforeEach(() => {
    client = new AetherfyVectorsClient({
      apiKey: 'afy_test_1234567890123456',
      endpoint: 'http://localhost:3000',
      enableConnectionPooling: false,
    });
  });

  it('should fetch schema on first upsert', async () => {
    // Mock GET collection response
    const getScope = nock('http://localhost:3000')
      .get('/collections/test-collection')
      .reply(200, {
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
      });

    // Mock PUT upsert response
    const putScope = nock('http://localhost:3000')
      .put('/collections/test-collection/points')
      .reply(200, { success: true });

    // First upsert
    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];
    await client.upsert('test-collection', points);

    // Should have made 2 calls: GET for schema, PUT for upsert
    expect(getScope.isDone()).toBe(true);
    expect(putScope.isDone()).toBe(true);
  });

  it('should reuse cached schema on subsequent upserts', async () => {
    // Mock GET collection response (only once)
    const getScope = nock('http://localhost:3000')
      .get('/collections/test-collection')
      .reply(200, {
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
      });

    // Mock PUT upsert responses (two times)
    const putScope = nock('http://localhost:3000')
      .put('/collections/test-collection/points')
      .times(2)
      .reply(200, { success: true });

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];

    // First upsert
    await client.upsert('test-collection', points);

    // Second upsert
    await client.upsert('test-collection', points);

    // Should have made 3 calls total: GET for schema (once), PUT for upsert (twice)
    // If cache is working, no second GET call
    expect(getScope.isDone()).toBe(true); // Only 1 GET call (schema was cached)
    expect(putScope.isDone()).toBe(true); // Two PUT calls
  });

  it('should send ETag in If-Match header', async () => {
    // Mock GET collection response
    nock('http://localhost:3000')
      .get('/collections/test-collection')
      .reply(200, {
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
      });

    // Mock PUT upsert response
    const putScope = nock('http://localhost:3000')
      .put('/collections/test-collection/points')
      .matchHeader('If-Match', 'abc12345')
      .reply(200, { success: true });

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];
    await client.upsert('test-collection', points);

    // Check If-Match header was sent in PUT request
    expect(putScope.isDone()).toBe(true);
  });

  it('should catch dimension mismatch client-side before request', async () => {
    // Mock GET collection response
    nock('http://localhost:3000')
      .get('/collections/test-collection')
      .reply(200, {
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
      });

    // Upsert with wrong dimensions (too small)
    const points = [{ id: '1', vector: new Array(384).fill(0.1), payload: {} }];

    try {
      await client.upsert('test-collection', points);
      throw new Error(
        'Should have thrown ValidationError for dimension mismatch'
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toMatch(/dimension mismatch/i);
      expect((error as Error).message).toContain('expected 768');
      expect((error as Error).message).toContain('got 384');
    }

    // PUT should NOT have been called (failed validation client-side)
    expect(nock.isDone()).toBe(true);
  });

  it('should catch dimension mismatch for oversized vectors', async () => {
    // Mock GET collection response
    nock('http://localhost:3000')
      .get('/collections/test-collection')
      .reply(200, {
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
      });

    // Upsert with wrong dimensions (too large)
    const points = [
      { id: '1', vector: new Array(1536).fill(0.1), payload: {} },
    ];

    try {
      await client.upsert('test-collection', points);
      throw new Error(
        'Should have thrown ValidationError for dimension mismatch'
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toMatch(/dimension mismatch/i);
      expect((error as Error).message).toContain('expected 768');
      expect((error as Error).message).toContain('got 1536');
    }

    // PUT should NOT have been called (failed validation client-side)
    expect(nock.isDone()).toBe(true);
  });

  it('should handle 412 response (schema changed)', async () => {
    // First upsert - populate cache
    nock('http://localhost:3000')
      .get('/collections/test-collection')
      .reply(200, {
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
      });

    nock('http://localhost:3000')
      .put('/collections/test-collection/points')
      .reply(200, { success: true });

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];

    // First call succeeds and caches schema
    await client.upsert('test-collection', points);

    // Second upsert - schema changed on server
    // Mock PUT with 412 response (no GET needed because of cache)
    nock('http://localhost:3000')
      .put('/collections/test-collection/points')
      .reply(412, {
        message: 'Collection schema has changed',
        code: 'SCHEMA_VERSION_MISMATCH',
      });

    // This should throw ValidationError with schema changed message
    try {
      await client.upsert('test-collection', points);
      throw new Error('Should have thrown ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toMatch(/schema.*changed/i);
      expect((error as Error).message).toContain('test-collection');
    }

    // Verify cache was cleared by checking next call fetches schema again
    const getScope2 = nock('http://localhost:3000')
      .get('/collections/test-collection')
      .reply(200, {
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
        schema_version: 'new-version',
      });

    nock('http://localhost:3000')
      .put('/collections/test-collection/points')
      .reply(200, { success: true });

    // This call should fetch schema again (because cache was cleared)
    await client.upsert('test-collection', points);

    // Verify schema was fetched (should have 2 GET calls total now)
    expect(getScope2.isDone()).toBe(true);
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
    nock('http://localhost:3000')
      .get('/collections/test-collection')
      .reply(200, {
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
      });

    // Mock PUT with 400 response
    nock('http://localhost:3000')
      .put('/collections/test-collection/points')
      .reply(400, {
        message: 'Vector dimension mismatch: expected 768, got 384',
        code: 'DIMENSION_MISMATCH',
      });

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];

    try {
      await client.upsert('test-collection', points);
      throw new Error('Should have thrown ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toMatch(/dimension mismatch/i);
    }
  });

  it('should handle 500 server error', async () => {
    // Mock GET collection response
    nock('http://localhost:3000')
      .get('/collections/test-collection')
      .reply(200, {
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
      });

    // Mock PUT with 500 response
    nock('http://localhost:3000')
      .put('/collections/test-collection/points')
      .reply(500, {
        message: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];

    // Should throw AetherfyVectorsError with server error message
    try {
      await client.upsert('test-collection', points);
      throw new Error('Should have thrown AetherfyVectorsError');
    } catch (error) {
      expect(error).toBeInstanceOf(AetherfyVectorsError);
      expect((error as Error).message).toMatch(/server error/i);
      expect((error as Error).message).toContain('Internal server error');
    }
  });

  it('should handle 503 server error', async () => {
    // Mock GET collection response
    nock('http://localhost:3000')
      .get('/collections/test-collection')
      .reply(200, {
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
      });

    // Mock PUT with 503 response (Service Unavailable)
    nock('http://localhost:3000')
      .put('/collections/test-collection/points')
      .reply(503, {
        message: 'Service temporarily unavailable',
        code: 'SERVICE_UNAVAILABLE',
      });

    const points = [{ id: '1', vector: new Array(768).fill(0.1), payload: {} }];

    // Should throw AetherfyVectorsError for 5xx errors
    try {
      await client.upsert('test-collection', points);
      throw new Error('Should have thrown AetherfyVectorsError');
    } catch (error) {
      expect(error).toBeInstanceOf(AetherfyVectorsError);
      expect((error as Error).message).toMatch(/server error/i);
    }
  });

  it('should validate vector array exists', async () => {
    // Mock GET collection response
    nock('http://localhost:3000')
      .get('/collections/test-collection')
      .reply(200, {
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
      });

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
