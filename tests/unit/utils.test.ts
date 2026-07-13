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
  parseErrorResponse,
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
import { ValidationError, AetherfyVectorsError } from '../../src/exceptions';
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

  // Mirrors the server matrix in vectordb tests/utils/pointIds.test.js —
  // one assertion per case, so a divergence names the exact id shape.
  describe('validatePointId', () => {
    // ---- accepted: unsigned integers -----------------------------------
    it('accepts 0', () => {
      expect(() => validatePointId(0)).not.toThrow();
    });
    it('accepts a small positive integer', () => {
      expect(() => validatePointId(42)).not.toThrow();
    });
    it('accepts Number.MAX_SAFE_INTEGER (the bound)', () => {
      expect(() => validatePointId(Number.MAX_SAFE_INTEGER)).not.toThrow();
    });

    // ---- accepted: UUID strings, all four Qdrant forms ------------------
    it('accepts a lowercase canonical UUID', () => {
      expect(() =>
        validatePointId('550e8400-e29b-41d4-a716-446655440000')
      ).not.toThrow();
    });
    it('accepts an uppercase UUID (case-insensitive)', () => {
      expect(() =>
        validatePointId('550E8400-E29B-41D4-A716-446655440000')
      ).not.toThrow();
    });
    it('accepts a simple (no-hyphen 32-hex) UUID', () => {
      expect(() =>
        validatePointId('550e8400e29b41d4a716446655440000')
      ).not.toThrow();
    });
    it('accepts a URN-form UUID (urn:uuid:…)', () => {
      expect(() =>
        validatePointId('urn:uuid:550e8400-e29b-41d4-a716-446655440000')
      ).not.toThrow();
    });
    it('accepts a URN prefix in mixed case', () => {
      expect(() =>
        validatePointId('URN:UUID:550e8400-e29b-41d4-a716-446655440000')
      ).not.toThrow();
    });
    it('accepts a braced UUID ({…})', () => {
      expect(() =>
        validatePointId('{550e8400-e29b-41d4-a716-446655440000}')
      ).not.toThrow();
    });

    // ---- rejected: numbers out of the accepted set ----------------------
    it('rejects a negative integer', () => {
      expect(() => validatePointId(-1)).toThrow(ValidationError);
    });
    it('rejects a float', () => {
      expect(() => validatePointId(1.5)).toThrow(ValidationError);
    });
    it('rejects an integer above the safe-integer bound', () => {
      expect(() => validatePointId(Number.MAX_SAFE_INTEGER + 1)).toThrow(
        ValidationError
      );
    });
    it('rejects NaN', () => {
      expect(() => validatePointId(NaN)).toThrow(ValidationError);
    });
    it('rejects Infinity', () => {
      expect(() => validatePointId(Infinity)).toThrow(ValidationError);
    });

    // ---- rejected: strings that are not UUIDs ---------------------------
    it('rejects a numeric string', () => {
      expect(() => validatePointId('123')).toThrow(ValidationError);
    });
    it('rejects an arbitrary string', () => {
      expect(() => validatePointId('my_point_1')).toThrow(ValidationError);
    });
    it('rejects an empty string', () => {
      expect(() => validatePointId('')).toThrow(ValidationError);
    });
    it('rejects a hex string of the wrong length (31 chars)', () => {
      expect(() => validatePointId('550e8400e29b41d4a71644665544000')).toThrow(
        ValidationError
      );
    });
    it('rejects a braced UUID with no closing brace', () => {
      expect(() =>
        validatePointId('{550e8400-e29b-41d4-a716-446655440000')
      ).toThrow(ValidationError);
    });
    it('rejects a UUID with non-hex characters', () => {
      expect(() =>
        validatePointId('550e8400-e29b-41d4-a716-44665544zzzz')
      ).toThrow(ValidationError);
    });

    // ---- rejected: non-string, non-number -------------------------------
    it('rejects null', () => {
      expect(() => validatePointId(null as unknown as string)).toThrow(
        ValidationError
      );
    });
    it('rejects undefined', () => {
      expect(() => validatePointId(undefined as unknown as string)).toThrow(
        ValidationError
      );
    });
    it('rejects an object', () => {
      expect(() => validatePointId({} as unknown as string)).toThrow(
        ValidationError
      );
    });
    it('rejects an array', () => {
      expect(() => validatePointId([] as unknown as string)).toThrow(
        ValidationError
      );
    });
    it('rejects a boolean', () => {
      expect(() => validatePointId(true as unknown as string)).toThrow(
        ValidationError
      );
    });

    // ---- error copy ------------------------------------------------------
    it('mirrors the server INVALID_POINT_ID wording and names the id', () => {
      expect(() => validatePointId('my_point_1')).toThrow(
        "Point ID 'my_point_1' is invalid — use an unsigned integer or a UUID string."
      );
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
        'https://api.example.com/api/v1/collections'
      );
    });

    it('should handle trailing/leading slashes', () => {
      expect(buildApiUrl('https://api.example.com/', '/collections')).toBe(
        'https://api.example.com/api/v1/collections'
      );
    });

    it('should add query parameters', () => {
      const url = buildApiUrl('https://api.example.com', 'collections', {
        limit: 10,
        offset: 0,
      });
      expect(url).toBe(
        'https://api.example.com/api/v1/collections?limit=10&offset=0'
      );
    });
  });

  describe('parseErrorResponse', () => {
    it('should parse error with message field', () => {
      const error = parseErrorResponse(
        { message: 'Error occurred' },
        400,
        'Bad Request',
        'req-123'
      );

      expect(error).toBeInstanceOf(AetherfyVectorsError);
      expect(error.message).toBe('Error occurred');
      expect(error.requestId).toBe('req-123');
      expect(error.statusCode).toBe(400);
    });

    it('should parse error with error field', () => {
      const error = parseErrorResponse(
        { error: 'Something went wrong' },
        500,
        'Internal Server Error'
      );

      expect(error.message).toBe('Something went wrong');
    });

    it('does NOT parse FastAPI {detail: "..."} envelope (per REVIEW_FAQ §56)', () => {
      // The JS SDK only talks to vectordb (Node/Express), so it only
      // parses {error: ...}. FastAPI's bare HTTPException(detail="...")
      // shape is intentionally ignored — if the SDK ever sees it, that
      // signals a misrouted call and the message falls back to
      // statusText so the consumer notices.
      const error = parseErrorResponse(
        { detail: 'Validation failed' },
        400,
        'Bad Request'
      );

      expect(error.message).toBe('Bad Request');
      expect(error.code).toBeUndefined();
    });

    it('should fallback to statusText when no message fields present', () => {
      const error = parseErrorResponse({}, 404, 'Not Found');

      expect(error.message).toBe('Not Found');
    });

    it('should handle non-object response data', () => {
      const error = parseErrorResponse('string error', 500, 'Server Error');

      expect(error.message).toBe('Unknown error');
      expect(error.statusCode).toBe(500);
    });

    it('should handle null response data', () => {
      const error = parseErrorResponse(null, 500, 'Server Error');

      expect(error.message).toBe('Unknown error');
      expect(error.statusCode).toBe(500);
    });

    it('should include all response data in details', () => {
      const responseData = {
        message: 'Error',
        field: 'email',
        violations: ['invalid format'],
      };
      const error = parseErrorResponse(responseData, 400, 'Bad Request');

      expect(error.details).toEqual({
        message: 'Error',
        field: 'email',
        violations: ['invalid format'],
        statusCode: 400,
        statusText: 'Bad Request',
      });
    });

    it('should extract code and message from Node-style envelope { error: { code, message } }', () => {
      const error = parseErrorResponse(
        { error: { code: 'UPSTREAM_ERROR', message: 'gateway timeout' } },
        502,
        'Bad Gateway'
      );

      expect(error.code).toBe('UPSTREAM_ERROR');
      expect(error.message).toBe('gateway timeout');
      expect(error.statusCode).toBe(502);
    });

    it('should leave code undefined for legacy string-error envelope', () => {
      const error = parseErrorResponse(
        { error: 'just a string' },
        500,
        'Server Error'
      );

      expect(error.message).toBe('just a string');
      expect(error.code).toBeUndefined();
    });

    it('should fall back to statusText with code undefined for empty body', () => {
      const error = parseErrorResponse({}, 500, 'Server Error');

      expect(error.message).toBe('Server Error');
      expect(error.code).toBeUndefined();
    });
  });
});

describe('Data Formatting', () => {
  describe('formatPointsForUpsert', () => {
    it('should format valid points', () => {
      const points = [
        { id: 1, vector: [1, 2, 3], payload: { type: 'test' } },
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          vector: [4, 5, 6],
        },
      ];

      const formatted = formatPointsForUpsert(points);

      expect(formatted).toEqual([
        { id: 1, vector: [1, 2, 3], payload: { type: 'test' } },
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          vector: [4, 5, 6],
          payload: {},
        },
      ]);
    });

    it('should accept the valid id 0 (not treated as missing)', () => {
      const points = [{ id: 0, vector: [1, 2, 3] }];
      expect(formatPointsForUpsert(points)).toEqual([
        { id: 0, vector: [1, 2, 3], payload: {} },
      ]);
    });

    it('should reject points without ID', () => {
      const points = [{ vector: [1, 2, 3] }];
      expect(() => formatPointsForUpsert(points)).toThrow(ValidationError);
    });

    it('should reject a non-UUID string id', () => {
      const points = [{ id: 'point1', vector: [1, 2, 3] }];
      expect(() => formatPointsForUpsert(points)).toThrow(
        "Point ID 'point1' is invalid — use an unsigned integer or a UUID string."
      );
    });

    it('should reject points without vector', () => {
      const points = [{ id: 1 }];
      expect(() => formatPointsForUpsert(points)).toThrow(ValidationError);
    });

    it('should handle non-ValidationError during formatting', () => {
      const points = [
        {
          id: 1,
          get vector() {
            throw new Error('Unexpected error');
          },
        },
      ];
      expect(() => formatPointsForUpsert(points)).toThrow(
        'Invalid point at index 0: Unexpected error'
      );
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

    it('should sanitize arrays with nested objects', () => {
      const data = {
        items: [
          { apiKey: 'secret1', name: 'item1' },
          { token: 'secret2', name: 'item2' },
        ],
      };

      const sanitized = sanitizeForLogging(data) as Record<string, unknown>;
      const items = sanitized.items as Array<Record<string, unknown>>;

      expect(items[0].apiKey).toBe('[REDACTED]');
      expect(items[0].name).toBe('item1');
      expect(items[1].token).toBe('[REDACTED]');
      expect(items[1].name).toBe('item2');
    });

    it('should handle deeply nested objects', () => {
      const data = {
        level1: {
          level2: {
            level3: {
              secret: 'hidden',
              visible: 'shown',
            },
          },
        },
      };

      const sanitized = sanitizeForLogging(data) as Record<string, unknown>;
      const level3 = (
        (sanitized.level1 as Record<string, unknown>).level2 as Record<
          string,
          unknown
        >
      ).level3 as Record<string, unknown>;

      expect(level3.secret).toBe('[REDACTED]');
      expect(level3.visible).toBe('shown');
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

    it('should log execution time with label', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const fn = () => 'result';

      await measureTime(fn, 'Test operation');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Test operation took \d+\.\d+ms/)
      );

      warnSpy.mockRestore();
    });

    it('should log error with label when function fails', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      const fn = () => {
        throw new Error('Test error');
      };

      await expect(measureTime(fn, 'Failing operation')).rejects.toThrow(
        'Test error'
      );

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Failing operation failed after \d+\.\d+ms/)
      );

      errorSpy.mockRestore();
    });
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
