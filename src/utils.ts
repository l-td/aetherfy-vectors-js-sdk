import { Point, DistanceMetric } from './models';
import { AetherfyVectorsError, ValidationError } from './exceptions';

/**
 * Environment detection utilities
 */

/**
 * Check if running in browser environment
 */
export function isBrowser(): boolean {
  return (
    typeof window !== 'undefined' && typeof window.document !== 'undefined'
  );
}

/**
 * Check if running in Node.js environment
 */
export function isNode(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.versions !== null &&
    typeof process.versions === 'object' &&
    typeof process.versions.node === 'string'
  );
}

/**
 * Check if running in Web Worker environment
 */
export function isWebWorker(): boolean {
  return (
    typeof (globalThis as Record<string, unknown>).importScripts ===
      'function' &&
    typeof (globalThis as Record<string, unknown>).WorkerGlobalScope !==
      'undefined'
  );
}

/**
 * Validation utilities
 */

/**
 * Validate a vector array
 *
 * @param vector - Vector to validate
 * @param expectedDimension - Expected dimension (optional)
 * @throws ValidationError if vector is invalid
 */
export function validateVector(
  vector: number[],
  expectedDimension?: number
): void {
  if (!Array.isArray(vector)) {
    throw new ValidationError('Vector must be an array of numbers');
  }

  if (vector.length === 0) {
    throw new ValidationError('Vector cannot be empty');
  }

  if (expectedDimension && vector.length !== expectedDimension) {
    throw new ValidationError(
      `Vector dimension mismatch: expected ${expectedDimension}, got ${vector.length}`
    );
  }

  for (let i = 0; i < vector.length; i++) {
    const val = vector[i];
    if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) {
      throw new ValidationError(
        `Invalid vector component at index ${i}: ${val}`
      );
    }
  }
}

/**
 * Validate collection name
 *
 * @param name - Collection name to validate
 * @throws ValidationError if name is invalid
 */
export function validateCollectionName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new ValidationError('Collection name must be a non-empty string');
  }

  if (name.length < 1 || name.length > 255) {
    throw new ValidationError(
      'Collection name must be between 1 and 255 characters'
    );
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new ValidationError(
      'Collection name can only contain letters, numbers, underscores, and hyphens'
    );
  }

  if (name.startsWith('-') || name.endsWith('-')) {
    throw new ValidationError(
      'Collection name cannot start or end with a hyphen'
    );
  }
}

/**
 * Validate point ID
 *
 * @param id - Point ID to validate
 * @throws ValidationError if ID is invalid
 */
export function validatePointId(id: string | number): void {
  if (id === null || id === undefined) {
    throw new ValidationError('Point ID cannot be null or undefined');
  }

  if (typeof id === 'string') {
    if (id.length === 0) {
      throw new ValidationError('Point ID cannot be an empty string');
    }
    if (id.length > 255) {
      throw new ValidationError('Point ID cannot exceed 255 characters');
    }
  } else if (typeof id === 'number') {
    if (!isFinite(id)) {
      throw new ValidationError('Point ID must be a finite number');
    }
  } else {
    throw new ValidationError('Point ID must be a string or number');
  }
}

/**
 * Validate distance metric
 *
 * @param metric - Distance metric to validate
 * @throws ValidationError if metric is invalid
 */
export function validateDistanceMetric(metric: string): void {
  const validMetrics = Object.values(DistanceMetric);
  if (!validMetrics.includes(metric as DistanceMetric)) {
    throw new ValidationError(
      `Invalid distance metric '${metric}'. Valid options: ${validMetrics.join(', ')}`
    );
  }
}

/**
 * URL and request utilities
 */

/**
 * Build API URL with proper encoding
 *
 * @param baseUrl - Base URL
 * @param endpoint - API endpoint
 * @param params - Optional query parameters
 * @returns Complete API URL
 */
export function buildApiUrl(
  baseUrl: string,
  endpoint: string,
  params?: Record<string, string | number>
): string {
  // Remove trailing slash from baseUrl and leading slash from endpoint
  const cleanBaseUrl = baseUrl.replace(/\/$/, '');
  const cleanEndpoint = endpoint.replace(/^\//, '');

  let url = `${cleanBaseUrl}/${cleanEndpoint}`;

  if (params && Object.keys(params).length > 0) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      searchParams.append(key, String(value));
    });
    url += `?${searchParams.toString()}`;
  }

  return url;
}

/**
 * Parse error response from API
 *
 * @param responseData - Response data
 * @param statusCode - HTTP status code
 * @param statusText - HTTP status text
 * @param requestId - Optional request ID
 * @returns Parsed error object
 */
export function parseErrorResponse(
  responseData: unknown,
  statusCode: number,
  statusText: string,
  requestId?: string
): AetherfyVectorsError {
  let message = 'Unknown error';
  let details: Record<string, unknown> = { statusCode, statusText };

  if (responseData && typeof responseData === 'object') {
    const data = responseData as Record<string, unknown>;
    message =
      (typeof data.message === 'string' ? data.message : undefined) ||
      (typeof data.error === 'string' ? data.error : undefined) ||
      (typeof data.detail === 'string' ? data.detail : undefined) ||
      statusText ||
      'Unknown error';

    details = {
      ...data,
      statusCode,
      statusText,
    };
  }

  return new AetherfyVectorsError(message, requestId, statusCode, details);
}

/**
 * Data formatting utilities
 */

/**
 * Format points for upsert operation
 *
 * @param points - Raw points data
 * @returns Formatted points
 */
export function formatPointsForUpsert(
  points: (Point | Record<string, unknown>)[]
): Point[] {
  return points.map((point, index) => {
    try {
      if (
        !point ||
        typeof point !== 'object' ||
        !('id' in point) ||
        !point.id
      ) {
        throw new ValidationError(`Point at index ${index} must have an id`);
      }

      if (
        !('vector' in point) ||
        !point.vector ||
        !Array.isArray(point.vector)
      ) {
        throw new ValidationError(
          `Point at index ${index} must have a vector array`
        );
      }

      validatePointId(point.id as string | number);
      validateVector(point.vector as number[]);

      return {
        id: point.id as string | number,
        vector: point.vector as number[],
        payload: (point.payload as Record<string, unknown>) || {},
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError(
        `Invalid point at index ${index}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}

/**
 * Sanitize data for logging (remove sensitive information)
 *
 * @param data - Data to sanitize
 * @returns Sanitized data
 */
export function sanitizeForLogging(data: unknown): unknown {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const sensitiveKeys = [
    'api_key',
    'apiKey',
    'authorization',
    'password',
    'secret',
    'token',
    'x-api-key',
    'bearer',
    'auth',
    'credentials',
  ];

  function sanitizeObject(obj: unknown): unknown {
    if (Array.isArray(obj)) {
      return obj.map(sanitizeObject);
    }

    if (obj && typeof obj === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (
          sensitiveKeys.some(sensitiveKey =>
            lowerKey.includes(sensitiveKey.toLowerCase())
          )
        ) {
          sanitized[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null) {
          sanitized[key] = sanitizeObject(value);
        } else {
          sanitized[key] = value;
        }
      }
      return sanitized;
    }

    return obj;
  }

  return sanitizeObject(data);
}

/**
 * Retry logic with exponential backoff
 *
 * @param fn - Function to retry
 * @param options - Retry options
 * @returns Promise that resolves to function result
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
    backoffFactor?: number;
    retryCondition?: (_error: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    backoffFactor = 2,
    retryCondition = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !retryCondition(error)) {
        throw error;
      }

      const delay = Math.min(
        baseDelay * Math.pow(backoffFactor, attempt),
        maxDelay
      );

      // Add jitter to prevent thundering herd
      const jitteredDelay = delay * (0.5 + Math.random() * 0.5);

      await sleep(jitteredDelay);
    }
  }

  throw lastError;
}

/**
 * Sleep utility
 *
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after delay
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Batch array into chunks
 *
 * @param array - Array to batch
 * @param batchSize - Size of each batch
 * @returns Array of batches
 */
export function batchArray<T>(array: T[], batchSize: number): T[][] {
  if (batchSize <= 0) {
    throw new ValidationError('Batch size must be positive');
  }

  const batches: T[][] = [];
  for (let i = 0; i < array.length; i += batchSize) {
    batches.push(array.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Deep clone an object
 *
 * @param obj - Object to clone
 * @returns Cloned object
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date) {
    return new Date(obj.getTime()) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => deepClone(item)) as T;
  }

  const cloned: Record<string, unknown> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone((obj as Record<string, unknown>)[key]);
    }
  }

  return cloned as T;
}

/**
 * Type checking utilities
 */

/**
 * Check if value is a plain object
 *
 * @param value - Value to check
 * @returns True if value is a plain object
 */
export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

/**
 * Check if string is a valid JSON
 *
 * @param str - String to check
 * @returns True if string is valid JSON
 */
export function isValidJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Performance utilities
 */

/**
 * Measure execution time of a function
 *
 * @param fn - Function to measure
 * @param label - Optional label for logging
 * @returns Promise that resolves to [result, executionTimeMs]
 */
export async function measureTime<T>(
  fn: () => Promise<T> | T,
  label?: string
): Promise<[T, number]> {
  const startTime = performance.now ? performance.now() : Date.now();

  try {
    const result = await fn();
    const endTime = performance.now ? performance.now() : Date.now();
    const duration = endTime - startTime;

    if (label) {
      console.warn(`${label} took ${duration.toFixed(2)}ms`);
    }

    return [result, duration];
  } catch (error) {
    const endTime = performance.now ? performance.now() : Date.now();
    const duration = endTime - startTime;

    if (label) {
      console.error(`${label} failed after ${duration.toFixed(2)}ms`);
    }

    throw error;
  }
}

/**
 * Debounce function calls
 *
 * @param fn - Function to debounce
 * @param delay - Delay in milliseconds
 * @returns Debounced function
 */
export function debounce<T extends (..._args: never[]) => unknown>(
  fn: T,
  delay: number
): T {
  let timeoutId: ReturnType<typeof setTimeout>;

  return ((...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(null, args), delay);
  }) as T;
}

/**
 * Throttle function calls
 *
 * @param fn - Function to throttle
 * @param limit - Time limit in milliseconds
 * @returns Throttled function
 */
export function throttle<T extends (..._args: never[]) => unknown>(
  fn: T,
  limit: number
): T {
  let inThrottle: boolean;

  return ((...args: Parameters<T>) => {
    if (!inThrottle) {
      fn.apply(null, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  }) as T;
}
