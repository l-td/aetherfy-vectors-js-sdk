/**
 * Schema validation and type detection for Aetherfy Vectors SDK
 *
 * Provides schema definition, validation, and type detection functionality
 * to enforce data quality in vector collections.
 */

import type {
  DataType,
  Schema,
  FieldValidationError,
  VectorValidationError,
  Point,
} from './models';

/**
 * Detect the precise type of a value.
 *
 * @param value - Value to detect type of
 * @returns Type name: 'null', 'boolean', 'string', 'integer', 'float', 'array', 'object', 'unknown'
 */
export function detectType(value: unknown): DataType | 'unknown' {
  if (value === null) return 'null';
  if (value === undefined) return 'null'; // Treat undefined as null
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'float';
  }
  return 'unknown';
}

/**
 * Validate a payload against a schema.
 *
 * @param payload - Payload dictionary to validate
 * @param schema - Schema to validate against
 * @param path - Current field path (for nested validation)
 * @returns List of validation errors (empty if valid)
 */
export function validatePayload(
  payload: Record<string, unknown> | null | undefined,
  schema: Schema,
  path: string = ''
): FieldValidationError[] {
  const errors: FieldValidationError[] = [];

  // Handle null/undefined payload
  if (!payload) {
    payload = {};
  }

  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    const fieldPath = path ? `${path}.${fieldName}` : fieldName;
    const value = payload[fieldName];

    // Check required fields
    if (fieldDef.required && (value === undefined || value === null)) {
      errors.push({
        field: fieldPath,
        code: 'REQUIRED_FIELD_MISSING',
        message: `Required field '${fieldPath}' is missing`,
      });
      continue;
    }

    // Skip validation for optional missing fields
    if (value === undefined || value === null) {
      continue;
    }

    // Check type
    const actualType = detectType(value);
    if (actualType !== fieldDef.type) {
      errors.push({
        field: fieldPath,
        code: 'TYPE_MISMATCH',
        message: `Field '${fieldPath}' expected ${fieldDef.type}, got ${actualType}`,
        expected: fieldDef.type,
        actual: actualType,
      });
      continue;
    }

    // Check array element types
    if (
      fieldDef.type === 'array' &&
      fieldDef.elementType &&
      Array.isArray(value)
    ) {
      for (let i = 0; i < value.length; i++) {
        const elementType = detectType(value[i]);
        if (elementType !== fieldDef.elementType) {
          errors.push({
            field: `${fieldPath}[${i}]`,
            code: 'ARRAY_ELEMENT_TYPE_MISMATCH',
            message: `Array element at '${fieldPath}[${i}]' expected ${fieldDef.elementType}, got ${elementType}`,
            expected: fieldDef.elementType,
            actual: elementType,
          });
        }
      }
    }

    // Recursively validate nested objects
    if (
      fieldDef.type === 'object' &&
      fieldDef.fields &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const nestedSchema: Schema = { fields: fieldDef.fields };
      const nestedErrors = validatePayload(
        value as Record<string, unknown>,
        nestedSchema,
        fieldPath
      );
      errors.push(...nestedErrors);
    }
  }

  return errors;
}

/**
 * Validate multiple vectors against a schema.
 *
 * @param vectors - List of vector objects with payloads
 * @param schema - Schema to validate against
 * @returns List of validation errors per vector
 */
export function validateVectors(
  vectors: Array<Point | Record<string, unknown>>,
  schema: Schema
): VectorValidationError[] {
  const allErrors: VectorValidationError[] = [];

  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i];

    // Handle both Point objects and plain dictionaries
    let payload: Record<string, unknown> | null | undefined;
    let vectorId: string | number;

    if ('payload' in vector && vector.payload !== undefined) {
      // Point object
      payload = vector.payload as Record<string, unknown>;
      vectorId = (vector.id as string | number) || 'unknown';
    } else {
      // Dictionary format
      payload = (vector as Record<string, unknown>).payload as Record<
        string,
        unknown
      >;
      vectorId =
        ((vector as Record<string, unknown>).id as string | number) ||
        'unknown';
    }

    const errors = validatePayload(payload, schema);

    if (errors.length > 0) {
      allErrors.push({
        index: i,
        id: vectorId,
        errors,
      });
    }
  }

  return allErrors;
}
