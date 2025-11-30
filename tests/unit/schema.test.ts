/**
 * Unit tests for schema validation
 */

import { detectType, validatePayload, validateVectors } from '../../src/schema';
import { Schema, Point } from '../../src/models';

describe('Schema Validation', () => {
  describe('detectType', () => {
    it('should detect null', () => {
      expect(detectType(null)).toBe('null');
      expect(detectType(undefined)).toBe('null');
    });

    it('should detect boolean', () => {
      expect(detectType(true)).toBe('boolean');
      expect(detectType(false)).toBe('boolean');
    });

    it('should detect string', () => {
      expect(detectType('hello')).toBe('string');
      expect(detectType('')).toBe('string');
    });

    it('should detect integer', () => {
      expect(detectType(42)).toBe('integer');
      expect(detectType(0)).toBe('integer');
      expect(detectType(-10)).toBe('integer');
    });

    it('should detect float', () => {
      expect(detectType(3.14)).toBe('float');
      expect(detectType(0.5)).toBe('float');
      expect(detectType(-2.7)).toBe('float');
    });

    it('should detect array', () => {
      expect(detectType([])).toBe('array');
      expect(detectType([1, 2, 3])).toBe('array');
      expect(detectType(['a', 'b'])).toBe('array');
    });

    it('should detect object', () => {
      expect(detectType({})).toBe('object');
      expect(detectType({ key: 'value' })).toBe('object');
    });

    it('should return unknown for unsupported types', () => {
      expect(detectType(Symbol('test'))).toBe('unknown');
      expect(detectType(() => {})).toBe('unknown');
    });
  });

  describe('validatePayload', () => {
    it('should pass validation with valid payload', () => {
      const schema: Schema = {
        fields: {
          price: { type: 'integer', required: true },
          name: { type: 'string', required: false },
        },
      };

      const payload = { price: 100, name: 'Product A' };
      const errors = validatePayload(payload, schema);

      expect(errors).toHaveLength(0);
    });

    it('should fail on missing required field', () => {
      const schema: Schema = {
        fields: {
          price: { type: 'integer', required: true },
        },
      };

      const payload = { name: 'Product A' };
      const errors = validatePayload(payload, schema);

      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('REQUIRED_FIELD_MISSING');
      expect(errors[0].field).toBe('price');
    });

    it('should pass with missing optional field', () => {
      const schema: Schema = {
        fields: {
          price: { type: 'integer', required: true },
          description: { type: 'string', required: false },
        },
      };

      const payload = { price: 100 };
      const errors = validatePayload(payload, schema);

      expect(errors).toHaveLength(0);
    });

    it('should fail on type mismatch', () => {
      const schema: Schema = {
        fields: {
          price: { type: 'integer', required: true },
        },
      };

      const payload = { price: '100' };
      const errors = validatePayload(payload, schema);

      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe('TYPE_MISMATCH');
      expect(errors[0].expected).toBe('integer');
      expect(errors[0].actual).toBe('string');
    });

    it('should validate array element types', () => {
      const schema: Schema = {
        fields: {
          tags: { type: 'array', required: true, elementType: 'string' },
        },
      };

      const validPayload = { tags: ['tag1', 'tag2', 'tag3'] };
      const validErrors = validatePayload(validPayload, schema);
      expect(validErrors).toHaveLength(0);

      const invalidPayload = { tags: ['tag1', 123, 'tag3'] };
      const invalidErrors = validatePayload(invalidPayload, schema);
      expect(invalidErrors).toHaveLength(1);
      expect(invalidErrors[0].code).toBe('ARRAY_ELEMENT_TYPE_MISMATCH');
      expect(invalidErrors[0].field).toBe('tags[1]');
    });

    it('should validate nested objects', () => {
      const schema: Schema = {
        fields: {
          metadata: {
            type: 'object',
            required: true,
            fields: {
              source: { type: 'string', required: true },
              version: { type: 'integer', required: false },
            },
          },
        },
      };

      const validPayload = {
        metadata: { source: 'api', version: 2 },
      };
      const validErrors = validatePayload(validPayload, schema);
      expect(validErrors).toHaveLength(0);

      const invalidPayload = {
        metadata: { version: 2 },
      };
      const invalidErrors = validatePayload(invalidPayload, schema);
      expect(invalidErrors).toHaveLength(1);
      expect(invalidErrors[0].field).toBe('metadata.source');
      expect(invalidErrors[0].code).toBe('REQUIRED_FIELD_MISSING');
    });

    it('should handle null payload gracefully', () => {
      const schema: Schema = {
        fields: {
          price: { type: 'integer', required: false },
        },
      };

      const errors = validatePayload(null, schema);
      expect(errors).toHaveLength(0);
    });

    it('should handle undefined payload gracefully', () => {
      const schema: Schema = {
        fields: {
          price: { type: 'integer', required: false },
        },
      };

      const errors = validatePayload(undefined, schema);
      expect(errors).toHaveLength(0);
    });

    it('should validate multiple levels of nesting', () => {
      const schema: Schema = {
        fields: {
          data: {
            type: 'object',
            required: true,
            fields: {
              meta: {
                type: 'object',
                required: true,
                fields: {
                  author: { type: 'string', required: true },
                },
              },
            },
          },
        },
      };

      const validPayload = {
        data: {
          meta: {
            author: 'John Doe',
          },
        },
      };
      const validErrors = validatePayload(validPayload, schema);
      expect(validErrors).toHaveLength(0);

      const invalidPayload = {
        data: {
          meta: {
            author: 123,
          },
        },
      };
      const invalidErrors = validatePayload(invalidPayload, schema);
      expect(invalidErrors).toHaveLength(1);
      expect(invalidErrors[0].field).toBe('data.meta.author');
      expect(invalidErrors[0].code).toBe('TYPE_MISMATCH');
    });
  });

  describe('validateVectors', () => {
    it('should validate Point objects with valid payloads', () => {
      const schema: Schema = {
        fields: {
          price: { type: 'integer', required: true },
        },
      };

      const points: Point[] = [
        { id: '1', vector: [0.1, 0.2], payload: { price: 100 } },
        { id: '2', vector: [0.3, 0.4], payload: { price: 200 } },
      ];

      const errors = validateVectors(points, schema);
      expect(errors).toHaveLength(0);
    });

    it('should validate dictionary format vectors', () => {
      const schema: Schema = {
        fields: {
          name: { type: 'string', required: true },
        },
      };

      const vectors = [
        { id: 1, vector: [0.1], payload: { name: 'Test' } },
        { id: 2, vector: [0.2], payload: { name: 'Test2' } },
      ];

      const errors = validateVectors(vectors, schema);
      expect(errors).toHaveLength(0);
    });

    it('should return errors for invalid vectors', () => {
      const schema: Schema = {
        fields: {
          price: { type: 'integer', required: true },
          name: { type: 'string', required: true },
        },
      };

      const points: Point[] = [
        { id: '1', vector: [0.1], payload: { price: 100, name: 'Valid' } },
        {
          id: '2',
          vector: [0.2],
          payload: { price: 'invalid', name: 'Product' },
        },
        { id: '3', vector: [0.3], payload: { name: 'Missing price' } },
      ];

      const errors = validateVectors(points, schema);

      expect(errors).toHaveLength(2);

      // First error: vector at index 1 (id '2')
      expect(errors[0].index).toBe(1);
      expect(errors[0].id).toBe('2');
      expect(errors[0].errors).toHaveLength(1);
      expect(errors[0].errors[0].code).toBe('TYPE_MISMATCH');
      expect(errors[0].errors[0].field).toBe('price');

      // Second error: vector at index 2 (id '3')
      expect(errors[1].index).toBe(2);
      expect(errors[1].id).toBe('3');
      expect(errors[1].errors).toHaveLength(1);
      expect(errors[1].errors[0].code).toBe('REQUIRED_FIELD_MISSING');
      expect(errors[1].errors[0].field).toBe('price');
    });

    it('should handle vectors without payload', () => {
      const schema: Schema = {
        fields: {
          optional: { type: 'string', required: false },
        },
      };

      const points: Point[] = [
        { id: '1', vector: [0.1] },
        { id: '2', vector: [0.2], payload: {} },
      ];

      const errors = validateVectors(points, schema);
      expect(errors).toHaveLength(0);
    });

    it('should validate mixed array element types', () => {
      const schema: Schema = {
        fields: {
          scores: { type: 'array', required: true, elementType: 'integer' },
        },
      };

      const points: Point[] = [
        { id: '1', vector: [0.1], payload: { scores: [1, 2, 3] } },
        { id: '2', vector: [0.2], payload: { scores: [4, 5.5, 6] } },
      ];

      const errors = validateVectors(points, schema);
      expect(errors).toHaveLength(1);
      expect(errors[0].index).toBe(1);
      expect(errors[0].errors[0].field).toBe('scores[1]');
      expect(errors[0].errors[0].code).toBe('ARRAY_ELEMENT_TYPE_MISMATCH');
    });

    it('should handle vectors with nested object validation', () => {
      const schema: Schema = {
        fields: {
          meta: {
            type: 'object',
            required: true,
            fields: {
              category: { type: 'string', required: true },
            },
          },
        },
      };

      const points: Point[] = [
        { id: '1', vector: [0.1], payload: { meta: { category: 'A' } } },
        { id: '2', vector: [0.2], payload: { meta: { category: 123 } } },
      ];

      const errors = validateVectors(points, schema);
      expect(errors).toHaveLength(1);
      expect(errors[0].index).toBe(1);
      expect(errors[0].errors[0].field).toBe('meta.category');
    });

    it('should handle vectors with null payloads', () => {
      const schema: Schema = {
        fields: {
          optional: { type: 'string', required: false },
        },
      };

      const points = [
        { id: '1', vector: [0.1], payload: null },
        { id: '2', vector: [0.2], payload: undefined },
      ];

      const errors = validateVectors(points as Point[], schema);
      expect(errors).toHaveLength(0);
    });

    it('should use "unknown" as ID when not provided', () => {
      const schema: Schema = {
        fields: {
          required: { type: 'string', required: true },
        },
      };

      const vectors = [{ vector: [0.1], payload: {} }];

      const errors = validateVectors(vectors, schema);
      expect(errors).toHaveLength(1);
      expect(errors[0].id).toBe('unknown');
    });
  });
});
