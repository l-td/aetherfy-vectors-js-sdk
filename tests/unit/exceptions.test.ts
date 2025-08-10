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

    it('should create CollectionNotFoundError', () => {
      const error = new CollectionNotFoundError('test-collection');
      expect(error.message).toBe("Collection 'test-collection' not found");
      expect(error.name).toBe('CollectionNotFoundError');
      expect(error.collectionName).toBe('test-collection');
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
