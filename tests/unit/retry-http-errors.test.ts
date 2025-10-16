/**
 * Unit tests for retry logic with HTTP errors
 */

import { retryWithBackoff } from '../../src/utils';
import {
  ServiceUnavailableError,
  RequestTimeoutError,
  NetworkError,
  RateLimitExceededError,
  ValidationError,
  AuthenticationError,
  CollectionNotFoundError,
  ConflictError,
  isRetryableError,
} from '../../src/exceptions';

describe('Retry Logic with HTTP Errors', () => {
  describe('Retryable Errors', () => {
    it('should retry on 502 Bad Gateway', async () => {
      jest.useFakeTimers();

      const fn = jest
        .fn()
        .mockRejectedValueOnce(new ServiceUnavailableError('Bad Gateway'))
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        baseDelay: 1000,
        retryCondition: isRetryableError,
      });

      await jest.runOnlyPendingTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    }, 10000);

    it('should retry on 503 Service Unavailable', async () => {
      jest.useFakeTimers();

      const fn = jest
        .fn()
        .mockRejectedValueOnce(
          new ServiceUnavailableError('Service Unavailable')
        )
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        baseDelay: 1000,
        retryCondition: isRetryableError,
      });

      await jest.runOnlyPendingTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    }, 10000);

    it('should retry on 504 Gateway Timeout', async () => {
      jest.useFakeTimers();

      const fn = jest
        .fn()
        .mockRejectedValueOnce(new ServiceUnavailableError('Gateway Timeout'))
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        baseDelay: 1000,
        retryCondition: isRetryableError,
      });

      await jest.runOnlyPendingTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    }, 10000);

    it('should retry on timeout errors', async () => {
      jest.useFakeTimers();

      const fn = jest
        .fn()
        .mockRejectedValueOnce(new RequestTimeoutError('Request timed out'))
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        baseDelay: 1000,
        retryCondition: isRetryableError,
      });

      await jest.runOnlyPendingTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    }, 10000);

    it('should retry on network errors', async () => {
      jest.useFakeTimers();

      const fn = jest
        .fn()
        .mockRejectedValueOnce(new NetworkError('Network connection failed'))
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        baseDelay: 1000,
        retryCondition: isRetryableError,
      });

      await jest.runOnlyPendingTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    }, 10000);

    it('should retry on 429 Rate Limit with retryAfter', async () => {
      jest.useFakeTimers();

      const fn = jest
        .fn()
        .mockRejectedValueOnce(
          new RateLimitExceededError('Rate limit exceeded', 2)
        )
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        baseDelay: 1000,
        retryCondition: isRetryableError,
      });

      await jest.runOnlyPendingTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    }, 10000);

    it('should fail after exhausting retries on persistent 503', async () => {
      const fn = jest
        .fn()
        .mockRejectedValue(new ServiceUnavailableError('Service Unavailable'));

      await expect(
        retryWithBackoff(fn, {
          maxRetries: 2,
          baseDelay: 1,
          retryCondition: isRetryableError,
        })
      ).rejects.toThrow('Service Unavailable');

      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    }, 15000);
  });

  describe('Non-Retryable Errors', () => {
    it('should NOT retry on 400 Bad Request', async () => {
      const fn = jest
        .fn()
        .mockRejectedValue(new ValidationError('Invalid request parameters'));

      await expect(
        retryWithBackoff(fn, {
          maxRetries: 3,
          baseDelay: 1,
          retryCondition: isRetryableError,
        })
      ).rejects.toThrow('Invalid request parameters');

      // Should fail immediately without retries
      expect(fn).toHaveBeenCalledTimes(1);
    }, 10000);

    it('should NOT retry on 401 Unauthorized', async () => {
      const fn = jest
        .fn()
        .mockRejectedValue(
          new AuthenticationError('Invalid or missing API key')
        );

      await expect(
        retryWithBackoff(fn, {
          maxRetries: 3,
          baseDelay: 1,
          retryCondition: isRetryableError,
        })
      ).rejects.toThrow('Invalid or missing API key');

      expect(fn).toHaveBeenCalledTimes(1);
    }, 10000);

    it('should NOT retry on 404 Not Found', async () => {
      const fn = jest
        .fn()
        .mockRejectedValue(new CollectionNotFoundError('test-collection'));

      await expect(
        retryWithBackoff(fn, {
          maxRetries: 3,
          baseDelay: 1,
          retryCondition: isRetryableError,
        })
      ).rejects.toThrow("Collection 'test-collection' not found");

      expect(fn).toHaveBeenCalledTimes(1);
    }, 10000);

    it('should NOT retry on 409 Conflict', async () => {
      const fn = jest
        .fn()
        .mockRejectedValue(
          new ConflictError('Resource already exists', 'collection-name')
        );

      await expect(
        retryWithBackoff(fn, {
          maxRetries: 3,
          baseDelay: 1,
          retryCondition: isRetryableError,
        })
      ).rejects.toThrow('Resource already exists');

      expect(fn).toHaveBeenCalledTimes(1);
    }, 10000);

    it('should NOT retry on 429 Rate Limit without retryAfter', async () => {
      const fn = jest
        .fn()
        .mockRejectedValue(new RateLimitExceededError('Rate limit exceeded'));

      await expect(
        retryWithBackoff(fn, {
          maxRetries: 3,
          baseDelay: 1,
          retryCondition: isRetryableError,
        })
      ).rejects.toThrow('Rate limit exceeded');

      // Should fail immediately since no retryAfter is provided
      expect(fn).toHaveBeenCalledTimes(1);
    }, 10000);
  });

  describe('isRetryableError Type Guard', () => {
    it('should identify ServiceUnavailableError as retryable', () => {
      expect(isRetryableError(new ServiceUnavailableError())).toBe(true);
    });

    it('should identify RequestTimeoutError as retryable', () => {
      expect(isRetryableError(new RequestTimeoutError())).toBe(true);
    });

    it('should identify NetworkError as retryable', () => {
      expect(isRetryableError(new NetworkError())).toBe(true);
    });

    it('should identify RateLimitExceededError with retryAfter as retryable', () => {
      expect(isRetryableError(new RateLimitExceededError('', 2))).toBe(true);
    });

    it('should identify RateLimitExceededError without retryAfter as NOT retryable', () => {
      expect(isRetryableError(new RateLimitExceededError())).toBe(false);
    });

    it('should identify ValidationError as NOT retryable', () => {
      expect(isRetryableError(new ValidationError())).toBe(false);
    });

    it('should identify AuthenticationError as NOT retryable', () => {
      expect(isRetryableError(new AuthenticationError())).toBe(false);
    });

    it('should identify CollectionNotFoundError as NOT retryable', () => {
      expect(isRetryableError(new CollectionNotFoundError('test'))).toBe(false);
    });

    it('should identify ConflictError as NOT retryable', () => {
      expect(isRetryableError(new ConflictError())).toBe(false);
    });

    it('should identify generic Error as NOT retryable', () => {
      expect(isRetryableError(new Error('generic error'))).toBe(false);
    });
  });
});
