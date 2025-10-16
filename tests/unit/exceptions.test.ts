/**
 * Unit tests for custom exceptions
 */

import {
  AetherfyVectorsError,
  AuthenticationError,
  RateLimitExceededError,
  ServiceUnavailableError,
  ValidationError,
  CollectionNotFoundError,
  PointNotFoundError,
  RequestTimeoutError,
  NetworkError,
  ConflictError,
  QuotaExceededError,
  createErrorFromResponse,
  isAetherfyVectorsError,
  isRetryableError,
} from '../../src/exceptions';

describe('Custom Exceptions', () => {
  describe('AetherfyVectorsError', () => {
    it('should create base error with message', () => {
      const error = new AetherfyVectorsError('Test error');
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('AetherfyVectorsError');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AetherfyVectorsError);
    });

    it('should include optional metadata', () => {
      const error = new AetherfyVectorsError('Test error', 'req-123', 400, {
        field: 'name',
      });

      expect(error.requestId).toBe('req-123');
      expect(error.statusCode).toBe(400);
      expect(error.details).toEqual({ field: 'name' });
    });

    it('should serialize to JSON correctly', () => {
      const error = new AetherfyVectorsError('Test error', 'req-123', 400, {
        field: 'name',
      });

      const json = error.toJSON();
      expect(json).toEqual({
        name: 'AetherfyVectorsError',
        message: 'Test error',
        requestId: 'req-123',
        statusCode: 400,
        details: { field: 'name' },
      });
    });
  });

  describe('Specific Error Types', () => {
    it('should create AuthenticationError', () => {
      const error = new AuthenticationError('Invalid key');
      expect(error.message).toBe('Invalid key');
      expect(error.name).toBe('AuthenticationError');
      expect(error).toBeInstanceOf(AetherfyVectorsError);
      expect(error).toBeInstanceOf(AuthenticationError);
    });

    it('should create RateLimitExceededError with retry info', () => {
      const error = new RateLimitExceededError('Rate limited', 60);
      expect(error.message).toBe('Rate limited');
      expect(error.name).toBe('RateLimitExceededError');
      expect(error.retryAfter).toBe(60);

      const json = error.toJSON();
      expect(json.retryAfter).toBe(60);
    });

    it('should create ValidationError with field info', () => {
      const error = new ValidationError('Validation failed', 'vector', [
        'must be array',
        'must not be empty',
      ]);

      expect(error.message).toBe('Validation failed');
      expect(error.name).toBe('ValidationError');
      expect(error.field).toBe('vector');
      expect(error.violations).toEqual(['must be array', 'must not be empty']);
    });

    it('should serialize ValidationError to JSON', () => {
      const error = new ValidationError('Validation failed', 'vector', [
        'must be array',
      ]);
      const json = error.toJSON();
      expect(json).toEqual({
        name: 'ValidationError',
        message: 'Validation failed',
        requestId: undefined,
        statusCode: undefined,
        details: undefined,
        field: 'vector',
        violations: ['must be array'],
      });
    });

    it('should create CollectionNotFoundError', () => {
      const error = new CollectionNotFoundError('test-collection');
      expect(error.message).toBe("Collection 'test-collection' not found");
      expect(error.name).toBe('CollectionNotFoundError');
      expect(error.collectionName).toBe('test-collection');
    });

    it('should serialize CollectionNotFoundError to JSON', () => {
      const error = new CollectionNotFoundError('test-collection');
      const json = error.toJSON();
      expect(json).toEqual({
        name: 'CollectionNotFoundError',
        message: "Collection 'test-collection' not found",
        requestId: undefined,
        statusCode: undefined,
        details: undefined,
        collectionName: 'test-collection',
      });
    });

    it('should create PointNotFoundError', () => {
      const error = new PointNotFoundError('point-1', 'test-collection');
      expect(error.message).toBe(
        "Point 'point-1' not found in collection 'test-collection'"
      );
      expect(error.name).toBe('PointNotFoundError');
      expect(error.pointId).toBe('point-1');
      expect(error.collectionName).toBe('test-collection');
    });

    it('should serialize PointNotFoundError to JSON', () => {
      const error = new PointNotFoundError('point-1', 'test-collection');
      const json = error.toJSON();
      expect(json).toEqual({
        name: 'PointNotFoundError',
        message: "Point 'point-1' not found in collection 'test-collection'",
        requestId: undefined,
        statusCode: undefined,
        details: undefined,
        pointId: 'point-1',
        collectionName: 'test-collection',
      });
    });

    it('should create RequestTimeoutError', () => {
      const error = new RequestTimeoutError('Timeout occurred', 5000);
      expect(error.message).toBe('Timeout occurred');
      expect(error.name).toBe('RequestTimeoutError');
      expect(error.timeoutMs).toBe(5000);
    });

    it('should serialize RequestTimeoutError to JSON', () => {
      const error = new RequestTimeoutError('Timeout occurred', 5000);
      const json = error.toJSON();
      expect(json).toEqual({
        name: 'RequestTimeoutError',
        message: 'Timeout occurred',
        requestId: undefined,
        statusCode: undefined,
        details: undefined,
        timeoutMs: 5000,
      });
    });

    it('should create NetworkError', () => {
      const cause = new Error('Connection refused');
      const error = new NetworkError('Network failed', cause);
      expect(error.message).toBe('Network failed');
      expect(error.name).toBe('NetworkError');
      expect(error.cause).toBe(cause);
    });

    it('should serialize NetworkError to JSON', () => {
      const cause = new Error('Connection refused');
      const error = new NetworkError('Network failed', cause);
      const json = error.toJSON();
      expect(json).toEqual({
        name: 'NetworkError',
        message: 'Network failed',
        requestId: undefined,
        statusCode: undefined,
        details: undefined,
        cause: 'Connection refused',
      });
    });

    it('should create ConflictError', () => {
      const error = new ConflictError('Resource exists', 'collection-name');
      expect(error.message).toBe('Resource exists');
      expect(error.name).toBe('ConflictError');
      expect(error.conflictingResource).toBe('collection-name');
    });

    it('should serialize ConflictError to JSON', () => {
      const error = new ConflictError('Resource exists', 'collection-name');
      const json = error.toJSON();
      expect(json).toEqual({
        name: 'ConflictError',
        message: 'Resource exists',
        requestId: undefined,
        statusCode: undefined,
        details: undefined,
        conflictingResource: 'collection-name',
      });
    });

    it('should create QuotaExceededError', () => {
      const error = new QuotaExceededError(
        'Quota exceeded',
        'points',
        1000,
        900
      );
      expect(error.message).toBe('Quota exceeded');
      expect(error.name).toBe('QuotaExceededError');
      expect(error.quotaType).toBe('points');
      expect(error.current).toBe(1000);
      expect(error.limit).toBe(900);
    });

    it('should serialize QuotaExceededError to JSON', () => {
      const error = new QuotaExceededError(
        'Quota exceeded',
        'points',
        1000,
        900
      );
      const json = error.toJSON();
      expect(json).toEqual({
        name: 'QuotaExceededError',
        message: 'Quota exceeded',
        requestId: undefined,
        statusCode: undefined,
        details: undefined,
        quotaType: 'points',
        current: 1000,
        limit: 900,
      });
    });
  });

  describe('Error Factory', () => {
    it('should create ValidationError for 400 status', () => {
      const error = createErrorFromResponse(
        { message: 'Invalid input', field: 'vector' },
        400,
        'Bad Request'
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.message).toBe('Invalid input');
    });

    it('should create AuthenticationError for 401 status', () => {
      const error = createErrorFromResponse(
        { message: 'Unauthorized' },
        401,
        'Unauthorized'
      );

      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error.message).toBe('Unauthorized');
    });

    it('should create CollectionNotFoundError for 404 with collection', () => {
      const error = createErrorFromResponse(
        { collectionName: 'missing-collection' },
        404,
        'Not Found'
      );

      expect(error).toBeInstanceOf(CollectionNotFoundError);
      expect(error.message).toBe("Collection 'missing-collection' not found");
    });

    it('should create RateLimitExceededError for 429 status', () => {
      const error = createErrorFromResponse(
        { message: 'Too many requests', retryAfter: 30 },
        429,
        'Too Many Requests'
      );

      expect(error).toBeInstanceOf(RateLimitExceededError);
      expect((error as RateLimitExceededError).retryAfter).toBe(30);
    });

    it('should create ServiceUnavailableError for 503 status', () => {
      const error = createErrorFromResponse(
        { message: 'Service down' },
        503,
        'Service Unavailable'
      );

      expect(error).toBeInstanceOf(ServiceUnavailableError);
    });

    it('should create generic error for unknown status', () => {
      const error = createErrorFromResponse(
        { message: 'Unknown error' },
        500,
        'Internal Server Error'
      );

      expect(error).toBeInstanceOf(AetherfyVectorsError);
      expect(error).not.toBeInstanceOf(ValidationError);
    });

    it('should create PointNotFoundError for 404 with pointId and collection', () => {
      const error = createErrorFromResponse(
        { pointId: 'point-123', collectionName: 'test-collection' },
        404,
        'Not Found'
      );

      expect(error).toBeInstanceOf(PointNotFoundError);
      expect((error as PointNotFoundError).pointId).toBe('point-123');
      expect((error as PointNotFoundError).collectionName).toBe(
        'test-collection'
      );
    });

    it('should create ConflictError for 409 status', () => {
      const error = createErrorFromResponse(
        { message: 'Resource exists', conflictingResource: 'my-collection' },
        409,
        'Conflict'
      );

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).conflictingResource).toBe(
        'my-collection'
      );
    });

    it('should handle message as object in createErrorFromResponse', () => {
      const error = createErrorFromResponse(
        { message: { nested: 'error' } },
        500,
        'Internal Server Error'
      );

      expect(error.message).toBe('{"nested":"error"}');
    });

    it('should handle non-string message types in createErrorFromResponse', () => {
      const error = createErrorFromResponse(
        { message: 12345 },
        500,
        'Internal Server Error'
      );

      expect(error.message).toBe('12345');
    });

    it('should handle error parsing in createErrorFromResponse catch block', () => {
      const circularRef: Record<string, unknown> = {};
      circularRef.self = circularRef;

      const error = createErrorFromResponse(
        { message: circularRef },
        500,
        'Internal Server Error'
      );

      expect(error.message).toBe('Internal Server Error');
    });
  });

  describe('Type Guards', () => {
    it('should identify Aetherfy errors', () => {
      const aetherfyError = new ValidationError('Test');
      const regularError = new Error('Test');

      expect(isAetherfyVectorsError(aetherfyError)).toBe(true);
      expect(isAetherfyVectorsError(regularError)).toBe(false);
    });

    it('should identify retryable errors', () => {
      const retryableErrors = [
        new ServiceUnavailableError(),
        new RequestTimeoutError(),
        new NetworkError(),
        new RateLimitExceededError('Limited', 60),
      ];

      const nonRetryableErrors = [
        new ValidationError(),
        new AuthenticationError(),
        new CollectionNotFoundError('test'),
      ];

      retryableErrors.forEach(error => {
        expect(isRetryableError(error)).toBe(true);
      });

      nonRetryableErrors.forEach(error => {
        expect(isRetryableError(error)).toBe(false);
      });

      // Rate limit without retry info should not be retryable
      const rateLimitNoRetry = new RateLimitExceededError('Limited');
      expect(isRetryableError(rateLimitNoRetry)).toBe(false);
    });
  });

  describe('Instanceof Checks', () => {
    it('should support proper instanceof checks', () => {
      const errors = [
        new AetherfyVectorsError('base'),
        new AuthenticationError(),
        new ValidationError(),
        new RateLimitExceededError(),
        new ServiceUnavailableError(),
        new CollectionNotFoundError('test'),
        new PointNotFoundError('1', 'test'),
        new RequestTimeoutError(),
        new NetworkError(),
        new ConflictError(),
        new QuotaExceededError('Points', 'points', 1000, 500),
      ];

      errors.forEach(error => {
        expect(error instanceof AetherfyVectorsError).toBe(true);
        expect(error instanceof Error).toBe(true);
      });
    });
  });
});
