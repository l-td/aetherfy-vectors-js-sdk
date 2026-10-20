/**
 * createErrorFromResponse against the error bodies vectordb really authors.
 *
 * vectordb nests an error's extras inside the error object
 * ({"error": {"code", "message", "field"?, "details"?}}). This parser used to
 * read `details` and a 400's `field` from the TOP level of the body, so
 * `ConflictError.details` and `ValidationError.field` were undefined on every
 * real answer, and the tests that passed hand-written bodies never noticed.
 * The bodies below are produced by vectordb's own code (see _provenance in the
 * fixture), not typed here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConflictError,
  ValidationError,
  createErrorFromResponse,
} from '../../src/exceptions';

const fixtures = JSON.parse(
  readFileSync(
    join(__dirname, '..', 'fixtures', 'vectordb-error-envelopes.json'),
    'utf8'
  )
) as Record<string, unknown>;

const body = (name: string) => fixtures[name] as Record<string, unknown>;

describe("createErrorFromResponse reads vectordb's real envelopes", () => {
  it('the fixture carries its provenance and every case', () => {
    expect(typeof fixtures._provenance).toBe('string');
    expect(Object.keys(fixtures).sort()).toEqual(
      [
        '_provenance',
        'mode_400',
        'too_soon_409',
        'unsuitable_422',
        'vectors_400',
      ].sort()
    );
  });

  it('400 with `field` on the error object (vectors) names the field and the code', () => {
    const error = createErrorFromResponse(
      body('vectors_400'),
      400,
      'Bad Request'
    ) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.field).toBe('vectors');
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('400 with `field` inside `details` (the performance mode) names the field', () => {
    const error = createErrorFromResponse(
      body('mode_400'),
      400,
      'Bad Request'
    ) as ValidationError;
    expect(error.field).toBe('performance_mode');
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('422 PERFORMANCE_MODE_UNSUITABLE is a ValidationError with its field and code', () => {
    const error = createErrorFromResponse(
      body('unsuitable_422'),
      422,
      'Unprocessable'
    ) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.field).toBe('performance_mode');
    expect(error.code).toBe('PERFORMANCE_MODE_UNSUITABLE');
  });

  it('409 PERFORMANCE_MODE_CHANGE_TOO_SOON is a ConflictError whose details carry the wait', () => {
    const error = createErrorFromResponse(
      body('too_soon_409'),
      409,
      'Conflict'
    ) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe('PERFORMANCE_MODE_CHANGE_TOO_SOON');
    expect(error.details).toEqual({
      field: 'performance_mode',
      retry_after_seconds: 437,
      cooldown_seconds: 900,
    });
  });
});
