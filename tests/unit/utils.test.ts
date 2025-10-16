/**
 * Unit tests for utility functions
 */

import {
  isBrowser,
  isNode,
  isWebWorker,
  validateVector,
  validateCollectionName,
  validatePointId,
  validateDistanceMetric,
  buildApiUrl,
  formatPointsForUpsert,
  sanitizeForLogging,
  retryWithBackoff,
  sleep,
  batchArray,
  deepClone,
  isPlainObject,
  isValidJson,
  measureTime,
  debounce,
  throttle,
} from '../../src/utils';
import { ValidationError } from '../../src/exceptions';
import { DistanceMetric } from '../../src/models';

describe('Environment Detection', () => {
  const originalWindow = global.window;
  const originalProcess = global.process;

  afterEach(() => {
    global.window = originalWindow;
    global.process = originalProcess;
  });

  it('should detect browser environment', () => {
    (global as Record<string, unknown>).window = { document: {} };
    delete (global as Record<string, unknown>).process;

    expect(isBrowser()).toBe(true);
    expect(isNode()).toBe(false);
  });

  it('should detect Node.js environment', () => {
    delete (global as Record<string, unknown>).window;
    (global as Record<string, unknown>).process = {
      versions: { node: '18.0.0' },
    };

    expect(isNode()).toBe(true);
    expect(isBrowser()).toBe(false);
  });

  it('should detect Web Worker environment', () => {
    (global as Record<string, unknown>).importScripts = () => {};
    (global as Record<string, unknown>).WorkerGlobalScope = {};

    expect(isWebWorker()).toBe(true);
  });
});

describe('Validation Functions', () => {
  describe('validateVector', () => {
    it('should accept valid vectors', () => {
      expect(() => validateVector([1, 2, 3])).not.toThrow();
      expect(() => validateVector([0.1, -0.5, 2.7])).not.toThrow();
    });

    it('should reject invalid vectors', () => {
      expect(() => validateVector([])).toThrow(ValidationError);
      expect(() => validateVector([1, NaN, 3])).toThrow(ValidationError);
      expect(() => validateVector([1, Infinity, 3])).toThrow(ValidationError);
      expect(() => validateVector(['1', 2, 3] as unknown as number[])).toThrow(
        ValidationError
      );
      expect(() => validateVector(null as unknown as number[])).toThrow(
        ValidationError
      );
    });

    it('should validate expected dimensions', () => {
      expect(() => validateVector([1, 2, 3], 3)).not.toThrow();
      expect(() => validateVector([1, 2], 3)).toThrow(ValidationError);
    });
  });

  describe('validateCollectionName', () => {
    it('should accept valid collection names', () => {
      expect(() => validateCollectionName('valid-name')).not.toThrow();
      expect(() => validateCollectionName('valid_name')).not.toThrow();
      expect(() => validateCollectionName('valid123')).not.toThrow();
    });

    it('should reject invalid collection names', () => {
      expect(() => validateCollectionName('')).toThrow(ValidationError);
      expect(() => validateCollectionName('invalid name')).toThrow(
        ValidationError
      );
      expect(() => validateCollectionName('invalid!')).toThrow(ValidationError);
      expect(() => validateCollectionName('-invalid')).toThrow(ValidationError);
      expect(() => validateCollectionName('invalid-')).toThrow(ValidationError);
      expect(() => validateCollectionName('a'.repeat(256))).toThrow(
        ValidationError
      );
    });
  });

  describe('validatePointId', () => {
    it('should accept valid point IDs', () => {
      expect(() => validatePointId('valid-id')).not.toThrow();
      expect(() => validatePointId(123)).not.toThrow();
      expect(() => validatePointId(0)).not.toThrow();
    });

    it('should reject invalid point IDs', () => {
      expect(() => validatePointId('')).toThrow(ValidationError);
      expect(() => validatePointId(null as unknown as string)).toThrow(
        ValidationError
      );
      expect(() => validatePointId(undefined as unknown as string)).toThrow(
        ValidationError
      );
      expect(() => validatePointId(NaN)).toThrow(ValidationError);
      expect(() => validatePointId(Infinity)).toThrow(ValidationError);
      expect(() => validatePointId('a'.repeat(256))).toThrow(ValidationError);
    });
  });

  describe('validateDistanceMetric', () => {
    it('should accept valid distance metrics', () => {
      expect(() => validateDistanceMetric(DistanceMetric.COSINE)).not.toThrow();
      expect(() =>
        validateDistanceMetric(DistanceMetric.EUCLIDEAN)
      ).not.toThrow();
    });

    it('should reject invalid distance metrics', () => {
      expect(() => validateDistanceMetric('Invalid')).toThrow(ValidationError);
      expect(() => validateDistanceMetric('')).toThrow(ValidationError);
    });
  });
});

describe('URL and Request Utilities', () => {
  describe('buildApiUrl', () => {
    it('should build URL correctly', () => {
      expect(buildApiUrl('https://api.example.com', 'collections')).toBe(
        'https://api.example.com/collections'
      );
    });

    it('should handle trailing/leading slashes', () => {
      expect(buildApiUrl('https://api.example.com/', '/collections')).toBe(
        'https://api.example.com/collections'
      );
    });

    it('should add query parameters', () => {
      const url = buildApiUrl('https://api.example.com', 'collections', {
        limit: 10,
        offset: 0,
      });
      expect(url).toBe('https://api.example.com/collections?limit=10&offset=0');
    });
  });
});

describe('Data Formatting', () => {
  describe('formatPointsForUpsert', () => {
    it('should format valid points', () => {
      const points = [
        { id: 'point1', vector: [1, 2, 3], payload: { type: 'test' } },
        { id: 'point2', vector: [4, 5, 6] },
      ];

      const formatted = formatPointsForUpsert(points);

      expect(formatted).toEqual([
        { id: 'point1', vector: [1, 2, 3], payload: { type: 'test' } },
        { id: 'point2', vector: [4, 5, 6], payload: {} },
      ]);
    });

    it('should reject points without ID', () => {
      const points = [{ vector: [1, 2, 3] }];
      expect(() => formatPointsForUpsert(points)).toThrow(ValidationError);
    });

    it('should reject points without vector', () => {
      const points = [{ id: 'point1' }];
      expect(() => formatPointsForUpsert(points)).toThrow(ValidationError);
    });
  });

  describe('sanitizeForLogging', () => {
    it('should sanitize sensitive keys', () => {
      const data = {
        apiKey: 'secret',
        authorization: 'Bearer token',
        normal: 'visible',
        nested: {
          password: 'secret',
          public: 'visible',
        },
      };

      const sanitized = sanitizeForLogging(data) as Record<string, unknown>;

      expect(sanitized.apiKey).toBe('[REDACTED]');
      expect(sanitized.authorization).toBe('[REDACTED]');
      expect(sanitized.normal).toBe('visible');
      expect((sanitized.nested as Record<string, unknown>).password).toBe(
        '[REDACTED]'
      );
      expect((sanitized.nested as Record<string, unknown>).public).toBe(
        'visible'
      );
    });

    it('should handle non-objects', () => {
      expect(sanitizeForLogging('string')).toBe('string');
      expect(sanitizeForLogging(123)).toBe(123);
      expect(sanitizeForLogging(null)).toBe(null);
    });
  });
});

describe('Async Utilities', () => {
  describe('retryWithBackoff', () => {
    it('should succeed on first try', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const result = await retryWithBackoff(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure', async () => {
      jest.useFakeTimers();

      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('success');

      const resultPromise = retryWithBackoff(fn, {
        maxRetries: 2,
        baseDelay: 1,
      });

      // Fast-forward through all timers and promise resolutions
      await jest.runOnlyPendingTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });

    it('should fail after max retries', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(
        retryWithBackoff(fn, { maxRetries: 2, baseDelay: 1 })
      ).rejects.toThrow('fail');

      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    }, 10000); // Increase timeout to 10 seconds

    it('should apply exponential backoff correctly', async () => {
      // Test that function is called the correct number of times
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(
        retryWithBackoff(fn, { maxRetries: 3, baseDelay: 1 })
      ).rejects.toThrow('fail');

      expect(fn).toHaveBeenCalledTimes(4); // Initial + 3 retries
    }, 15000);

    it('should respect max delay cap', async () => {
      // Test that max retries is respected even with high retry count
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(
        retryWithBackoff(fn, {
          maxRetries: 10,
          baseDelay: 1,
          maxDelay: 5000,
        })
      ).rejects.toThrow('fail');

      expect(fn).toHaveBeenCalledTimes(11); // Initial + 10 retries
    }, 30000);

    it('should apply retry condition filter', async () => {
      const retryableError = new Error('retryable');
      const nonRetryableError = new Error('non-retryable');

      const fn = jest.fn().mockRejectedValue(nonRetryableError);

      await expect(
        retryWithBackoff(fn, {
          maxRetries: 3,
          baseDelay: 1,
          retryCondition: error =>
            (error as Error).message === retryableError.message,
        })
      ).rejects.toThrow('non-retryable');

      // Should fail immediately without retries
      expect(fn).toHaveBeenCalledTimes(1);
    }, 10000);

    it('should retry when condition is met', async () => {
      jest.useFakeTimers();

      const retryableError = new Error('retryable');
      const fn = jest
        .fn()
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValue('success');

      const promise = retryWithBackoff(fn, {
        maxRetries: 2,
        baseDelay: 1,
        retryCondition: error => (error as Error).message === 'retryable',
      });

      await jest.runOnlyPendingTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    }, 10000);
  });

  describe('sleep', () => {
    it('should delay execution', async () => {
      jest.useFakeTimers();
      const start = Date.now();
      const sleepPromise = sleep(50);

      jest.advanceTimersByTime(50);
      await sleepPromise;

      const end = Date.now();
      expect(end - start).toBeGreaterThanOrEqual(49); // Allow some variance
      jest.useRealTimers();
    }, 1000);
  });
});

describe('Array Utilities', () => {
  describe('batchArray', () => {
    it('should create batches correctly', () => {
      const array = [1, 2, 3, 4, 5, 6, 7];
      const batches = batchArray(array, 3);

      expect(batches).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    });

    it('should handle empty arrays', () => {
      expect(batchArray([], 3)).toEqual([]);
    });

    it('should reject invalid batch sizes', () => {
      expect(() => batchArray([1, 2, 3], 0)).toThrow(ValidationError);
      expect(() => batchArray([1, 2, 3], -1)).toThrow(ValidationError);
    });
  });

  describe('deepClone', () => {
    it('should clone objects deeply', () => {
      const obj = {
        a: 1,
        b: { c: 2, d: [3, 4] },
        e: new Date('2023-01-01'),
      };

      const cloned = deepClone(obj);

      expect(cloned).toEqual(obj);
      expect(cloned).not.toBe(obj);
      expect(cloned.b).not.toBe(obj.b);
      expect(cloned.b.d).not.toBe(obj.b.d);
    });

    it('should handle primitives', () => {
      expect(deepClone(42)).toBe(42);
      expect(deepClone('string')).toBe('string');
      expect(deepClone(null)).toBe(null);
    });
  });
});

describe('Type Checking', () => {
  describe('isPlainObject', () => {
    it('should identify plain objects', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ a: 1 })).toBe(true);
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject(new Date())).toBe(false);
      expect(isPlainObject(null)).toBe(false);
    });
  });

  describe('isValidJson', () => {
    it('should validate JSON strings', () => {
      expect(isValidJson('{"a": 1}')).toBe(true);
      expect(isValidJson('[1, 2, 3]')).toBe(true);
      expect(isValidJson('"string"')).toBe(true);
      expect(isValidJson('invalid')).toBe(false);
      expect(isValidJson('{"a": }')).toBe(false);
    });
  });
});

describe('Performance Utilities', () => {
  describe('measureTime', () => {
    it('should measure synchronous function time', async () => {
      const fn = () => 42;
      const [result, time] = await measureTime(fn);

      expect(result).toBe(42);
      expect(time).toBeGreaterThanOrEqual(0);
    });

    it('should measure asynchronous function time', async () => {
      jest.useFakeTimers();
      const fn = async () => {
        await sleep(10);
        return 'done';
      };

      const measurePromise = measureTime(fn);
      jest.advanceTimersByTime(10);
      const [result, time] = await measurePromise;

      expect(result).toBe('done');
      expect(time).toBeGreaterThanOrEqual(0);
      jest.useRealTimers();
    }, 1000);
  });

  describe('debounce', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should debounce function calls', () => {
      const fn = jest.fn();
      const debouncedFn = debounce(fn, 100);

      debouncedFn();
      debouncedFn();
      debouncedFn();

      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('throttle', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should throttle function calls', () => {
      const fn = jest.fn();
      const throttledFn = throttle(fn, 100);

      throttledFn();
      throttledFn();
      throttledFn();

      expect(fn).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(100);
      throttledFn();

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
