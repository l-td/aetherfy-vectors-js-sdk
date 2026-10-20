/**
 * createErrorFromResponse against the error bodies vectordb really authors.
 *
 * vectordb puts every extra of an error directly on the error object
 * ({"error": {"code", "message", "field"?, "retry_after_seconds"?, ...}}). This
 * parser used to read `details` and a 400's `field` from the TOP level of the
 * body, so `ConflictError.details` and `ValidationError.field` were undefined on
 * every real answer, and the tests that passed hand-written bodies never noticed.
 * The bodies below are produced by vectordb's own code (see _provenance in the
 * fixture), not typed here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AuthenticationError,
  ConflictError,
  RateLimitExceededError,
  StorageModeNotInPlanError,
  ValidationError,
  createErrorFromResponse,
} from '../../src/exceptions';
import { refusedBeforeAnything } from '../../src/retry-policy';

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
        'limit_reached_429',
        'mode_400',
        'not_in_plan_403',
        'too_soon_409',
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

  it('400 for an unknown storage mode names its field and the accepted modes', () => {
    const error = createErrorFromResponse(
      body('mode_400'),
      400,
      'Bad Request'
    ) as ValidationError;
    expect(error.field).toBe('storage_mode');
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('403 STORAGE_MODE_NOT_IN_PLAN is its own class with typed fields, not an AuthenticationError', () => {
    const error = createErrorFromResponse(
      body('not_in_plan_403'),
      403,
      'Forbidden'
    ) as StorageModeNotInPlanError;
    expect(error).toBeInstanceOf(StorageModeNotInPlanError);
    expect(error).not.toBeInstanceOf(AuthenticationError);
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe('STORAGE_MODE_NOT_IN_PLAN');
    expect(error.storageMode).toBe('fast');
    expect(error.plan).toBe('starter');
    expect(error.requiredPlan).toBe('performance');
    expect(error.allowedModes).toEqual(['exact', 'balanced']);
    expect(error.details).toMatchObject({ field: 'storage_mode' });
    expect(refusedBeforeAnything(error)).toBe(false);
  });

  it('409 STORAGE_MODE_CHANGE_TOO_SOON is a ConflictError whose details carry the wait', () => {
    const error = createErrorFromResponse(
      body('too_soon_409'),
      409,
      'Conflict'
    ) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe('STORAGE_MODE_CHANGE_TOO_SOON');
    expect(error.details).toMatchObject({
      field: 'storage_mode',
      retry_after_seconds: 437,
      cooldown_seconds: 900,
    });
  });

  it('429 STORAGE_MODE_CHANGE_LIMIT_REACHED carries the limit and the reset, and is never retried', () => {
    const error = createErrorFromResponse(
      body('limit_reached_429'),
      429,
      'Too Many Requests'
    ) as RateLimitExceededError;
    expect(error).toBeInstanceOf(RateLimitExceededError);
    expect(error.code).toBe('STORAGE_MODE_CHANGE_LIMIT_REACHED');
    expect(error.details).toMatchObject({
      field: 'storage_mode',
      limit: 3,
      period: 'week',
      resets_at: '2026-10-26T00:00:00Z',
      retry_after_seconds: 392000,
    });
    // No top-level `retryAfter` (and no Retry-After header): the retry policy
    // does not treat it as a refusal worth repeating, because waiting inside
    // the period cannot succeed.
    expect(error.retryAfter).toBeUndefined();
    expect(refusedBeforeAnything(error)).toBe(false);
  });
});
