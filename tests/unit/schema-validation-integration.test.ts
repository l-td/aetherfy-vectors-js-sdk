/**
 * Integration tests for schema validation in upsert operations
 */

import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { SchemaValidationError } from '../../src/exceptions';
import { Point } from '../../src/models';

describe('Schema Validation Integration', () => {
  let client: AetherfyVectorsClient;

  beforeEach(() => {
    client = new AetherfyVectorsClient({
      apiKey: 'afy_test_1234567890123456',
      enableConnectionPooling: false,
    });
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('Client-side validation with strict enforcement', () => {
    it('should validate and allow valid data', async () => {
      // Mock GET /collections (vector config)
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: { size: 2, distance: 'Cosine' },
              },
            },
          },
          schema_version: 'vec_etag',
        });

      // Mock GET /api/v1/schema (payload schema)
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(200, {
          schema: {
            fields: {
              price: { type: 'integer', required: true },
              name: { type: 'string', required: true },
            },
          },
          enforcement_mode: 'strict',
          etag: 'schema_etag',
        });

      // Mock PUT /collections/test-collection/points (upsert)
      nock('https://vectors.aetherfy.com')
        .put('/collections/test-collection/points')
        .reply(200, { status: 'ok' });

      const points: Point[] = [
        {
          id: '1',
          vector: [0.1, 0.2],
          payload: { price: 100, name: 'Product A' },
        },
        {
          id: '2',
          vector: [0.3, 0.4],
          payload: { price: 200, name: 'Product B' },
        },
      ];

      const result = await client.upsert('test-collection', points);
      expect(result).toBe(true);
    });

    it('should block invalid data in strict mode', async () => {
      // Mock GET /collections
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: { size: 2, distance: 'Cosine' },
              },
            },
          },
          schema_version: 'vec_etag',
        });

      // Mock GET /api/v1/schema
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(200, {
          schema: {
            fields: {
              price: { type: 'integer', required: true },
            },
          },
          enforcement_mode: 'strict',
          etag: 'schema_etag',
        });

      const points: Point[] = [
        {
          id: '1',
          vector: [0.1, 0.2],
          payload: { price: 'invalid' }, // Wrong type
        },
      ];

      await expect(client.upsert('test-collection', points)).rejects.toThrow(
        SchemaValidationError
      );
    });

    it('should report multiple validation errors', async () => {
      // Mock GET /collections
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: { size: 2, distance: 'Cosine' },
              },
            },
          },
          schema_version: 'vec_etag',
        });

      // Mock GET /api/v1/schema
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(200, {
          schema: {
            fields: {
              price: { type: 'integer', required: true },
              name: { type: 'string', required: true },
            },
          },
          enforcement_mode: 'strict',
          etag: 'schema_etag',
        });

      const points: Point[] = [
        {
          id: '1',
          vector: [0.1, 0.2],
          payload: { price: 100, name: 'Valid' },
        },
        {
          id: '2',
          vector: [0.3, 0.4],
          payload: { price: 'invalid' }, // Wrong type + missing name
        },
      ];

      try {
        await client.upsert('test-collection', points);
        throw new Error('Should have thrown SchemaValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaValidationError);
        const validationError = error as SchemaValidationError;
        expect(validationError.validationErrors).toHaveLength(1);
        expect(validationError.validationErrors[0].index).toBe(1);
        expect(
          validationError.validationErrors[0].errors.length
        ).toBeGreaterThan(0);
      }
    });
  });

  describe('Client-side validation with warn enforcement', () => {
    it('should allow invalid data in warn mode', async () => {
      // Mock GET /collections
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: { size: 2, distance: 'Cosine' },
              },
            },
          },
          schema_version: 'vec_etag',
        });

      // Mock GET /api/v1/schema
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(200, {
          schema: {
            fields: {
              price: { type: 'integer', required: true },
            },
          },
          enforcement_mode: 'warn',
          etag: 'schema_etag',
        });

      // Mock PUT /collections/test-collection/points
      nock('https://vectors.aetherfy.com')
        .put('/collections/test-collection/points')
        .reply(200, { status: 'ok' });

      const points: Point[] = [
        {
          id: '1',
          vector: [0.1, 0.2],
          payload: { price: 'invalid' }, // Wrong type but should be allowed
        },
      ];

      const result = await client.upsert('test-collection', points);
      expect(result).toBe(true);
    });
  });

  describe('Client-side validation with off enforcement', () => {
    it('should skip validation when enforcement is off', async () => {
      // Mock GET /collections
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: { size: 2, distance: 'Cosine' },
              },
            },
          },
          schema_version: 'vec_etag',
        });

      // Mock GET /api/v1/schema
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(200, {
          schema: {
            fields: {
              price: { type: 'integer', required: true },
            },
          },
          enforcement_mode: 'off',
          etag: 'schema_etag',
        });

      // Mock PUT /collections/test-collection/points
      nock('https://vectors.aetherfy.com')
        .put('/collections/test-collection/points')
        .reply(200, { status: 'ok' });

      const points: Point[] = [
        {
          id: '1',
          vector: [0.1, 0.2],
          payload: { price: 'anything goes' }, // Should be allowed
        },
      ];

      const result = await client.upsert('test-collection', points);
      expect(result).toBe(true);
    });
  });

  describe('Upsert without schema', () => {
    it('should allow any data when no schema exists', async () => {
      // Mock GET /collections
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: { size: 2, distance: 'Cosine' },
              },
            },
          },
          schema_version: 'vec_etag',
        });

      // Mock GET /api/v1/schema (404 - no schema)
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(404, { error: { message: 'Schema not found' } });

      // Mock PUT /collections/test-collection/points
      nock('https://vectors.aetherfy.com')
        .put('/collections/test-collection/points')
        .reply(200, { status: 'ok' });

      const points: Point[] = [
        {
          id: '1',
          vector: [0.1, 0.2],
          payload: { anything: 'goes', random: 123 },
        },
      ];

      const result = await client.upsert('test-collection', points);
      expect(result).toBe(true);
    });
  });

  describe('412 Precondition Failed handling', () => {
    it('should retry upsert when schema changes (412)', async () => {
      // First attempt: GET /collections
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: { size: 2, distance: 'Cosine' },
              },
            },
          },
          schema_version: 'vec_etag_old',
        });

      // First attempt: GET /api/v1/schema
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(200, {
          schema: {
            fields: {
              price: { type: 'integer', required: true },
            },
          },
          enforcement_mode: 'strict',
          etag: 'old_etag',
        });

      // First attempt: PUT returns 412
      nock('https://vectors.aetherfy.com')
        .put('/collections/test-collection/points')
        .reply(412, {
          error: {
            code: 'SCHEMA_VERSION_MISMATCH',
            message: 'Schema has changed',
          },
        });

      // Retry: GET /api/v1/schema (fetch updated schema)
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(200, {
          schema: {
            fields: {
              price: { type: 'integer', required: true },
              description: { type: 'string', required: false },
            },
          },
          enforcement_mode: 'strict',
          etag: 'new_etag',
        });

      // Retry: GET /collections (refetch vector config)
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: { size: 2, distance: 'Cosine' },
              },
            },
          },
          schema_version: 'vec_etag_new',
        });

      // Retry: PUT succeeds
      nock('https://vectors.aetherfy.com')
        .put('/collections/test-collection/points')
        .reply(200, { status: 'ok' });

      const points: Point[] = [
        {
          id: '1',
          vector: [0.1, 0.2],
          payload: { price: 100 },
        },
      ];

      const result = await client.upsert('test-collection', points);
      expect(result).toBe(true);
    });

    it('should fail if data is invalid after schema refresh', async () => {
      // First attempt: GET /collections
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: { size: 2, distance: 'Cosine' },
              },
            },
          },
          schema_version: 'vec_etag',
        });

      // First attempt: GET /api/v1/schema (old schema: price optional)
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(200, {
          schema: {
            fields: {
              price: { type: 'integer', required: false },
            },
          },
          enforcement_mode: 'strict',
          etag: 'old_etag',
        });

      // First attempt: PUT returns 412
      nock('https://vectors.aetherfy.com')
        .put('/collections/test-collection/points')
        .reply(412, {
          error: { message: 'Schema changed' },
        });

      // Retry: GET /api/v1/schema (new schema: price required)
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(200, {
          schema: {
            fields: {
              price: { type: 'integer', required: true },
            },
          },
          enforcement_mode: 'strict',
          etag: 'new_etag',
        });

      const points: Point[] = [
        {
          id: '1',
          vector: [0.1, 0.2],
          payload: {}, // Missing required price in new schema
        },
      ];

      await expect(client.upsert('test-collection', points)).rejects.toThrow(
        SchemaValidationError
      );
    });
  });

  describe('Schema caching', () => {
    it('should cache payload schema on first upsert', async () => {
      // First upsert: GET /collections
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: { size: 2, distance: 'Cosine' },
              },
            },
          },
          schema_version: 'vec_etag',
        });

      // First upsert: GET /api/v1/schema
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(200, {
          schema: {
            fields: {
              price: { type: 'integer', required: true },
            },
          },
          enforcement_mode: 'off',
          etag: 'schema_etag',
        });

      // First upsert: PUT
      nock('https://vectors.aetherfy.com')
        .put('/collections/test-collection/points')
        .reply(200, { status: 'ok' });

      const points: Point[] = [
        { id: '1', vector: [0.1, 0.2], payload: { price: 100 } },
      ];

      await client.upsert('test-collection', points);

      // Second upsert: should NOT fetch schema again (uses cache)
      // Only PUT is mocked
      nock('https://vectors.aetherfy.com')
        .put('/collections/test-collection/points')
        .reply(200, { status: 'ok' });

      const result = await client.upsert('test-collection', points);
      expect(result).toBe(true);
    });

    it('should cache "no schema" state to avoid repeated fetches', async () => {
      // First upsert: GET /collections
      nock('https://vectors.aetherfy.com')
        .get('/collections/test-collection')
        .reply(200, {
          result: {
            config: {
              params: {
                vectors: { size: 2, distance: 'Cosine' },
              },
            },
          },
          schema_version: 'vec_etag',
        });

      // First upsert: GET /api/v1/schema (404)
      nock('https://vectors.aetherfy.com')
        .get('/api/v1/schema/test-collection')
        .reply(404, {});

      // First upsert: PUT
      nock('https://vectors.aetherfy.com')
        .put('/collections/test-collection/points')
        .reply(200, { status: 'ok' });

      const points: Point[] = [{ id: '1', vector: [0.1, 0.2], payload: {} }];

      await client.upsert('test-collection', points);

      // Second upsert: should NOT try to fetch schema again (cached null)
      // Only PUT is mocked
      nock('https://vectors.aetherfy.com')
        .put('/collections/test-collection/points')
        .reply(200, { status: 'ok' });

      const result = await client.upsert('test-collection', points);
      expect(result).toBe(true);
    });
  });
});
