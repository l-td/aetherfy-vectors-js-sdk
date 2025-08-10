/**
 * Aetherfy Vectors JavaScript SDK
 *
 * Global vector database with automatic replication and sub-50ms latency worldwide.
 *
 * @example
 * ```typescript
 * import { AetherfyVectorsClient, DistanceMetric } from 'aetherfy-vectors';
 *
 * const client = new AetherfyVectorsClient({
 *   apiKey: 'afy_live_your_api_key_here'
 * });
 *
 * await client.createCollection('products', {
 *   size: 384,
 *   distance: DistanceMetric.COSINE
 * });
 *
 * const results = await client.search('products', queryVector, {
 *   limit: 10,
 *   withPayload: true
 * });
 * ```
 *
 * @public
 */

// Main client export
export { AetherfyVectorsClient } from './client';

// Analytics client export
export { AnalyticsClient } from './analytics';

// Authentication exports
export { APIKeyManager, AuthenticationError as AuthError } from './auth';

// Model and type exports
export {
  // Enums
  DistanceMetric,

  // Core interfaces
  VectorConfig,
  Point,
  SearchResult,
  Collection,
  Filter,

  // Options interfaces
  SearchOptions,
  RetrieveOptions,
  CountOptions,
  ClientConfig,

  // Analytics interfaces
  PerformanceAnalytics,
  CollectionAnalytics,
  UsageStats,
  CacheStats,
  RegionInfo,

  // Utility interfaces
  ApiResponse,
  PaginationInfo,
  BatchResult,
} from './models';

// Exception exports
export {
  // Base error
  AetherfyVectorsError,

  // Specific errors
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

  // Utility functions
  createErrorFromResponse,
  isAetherfyVectorsError,
  isRetryableError,
} from './exceptions';

// Utility function exports
export {
  // Environment detection
  isBrowser,
  isNode,
  isWebWorker,

  // Validation
  validateVector,
  validateCollectionName,
  validatePointId,
  validateDistanceMetric,

  // URL and request utilities
  buildApiUrl,
  parseErrorResponse,

  // Data formatting
  formatPointsForUpsert,
  sanitizeForLogging,

  // Async utilities
  retryWithBackoff,
  sleep,

  // Array utilities
  batchArray,
  deepClone,

  // Type checking
  isPlainObject,
  isValidJson,

  // Performance utilities
  measureTime,
  debounce,
  throttle,
} from './utils';

// HTTP client types (for advanced usage)
export type {
  RequestConfig,
  HttpResponse,
  HttpClientOptions,
  ErrorResponse,
} from './http/types';

// Re-export HTTP client for advanced usage
export { HttpClient } from './http/client';

// Version information
export const VERSION = '1.0.0';

// Default export for convenience
import { AetherfyVectorsClient } from './client';
export default AetherfyVectorsClient;

/**
 * Create a new Aetherfy Vectors client instance
 *
 * @param config - Client configuration
 * @returns Configured client instance
 *
 * @example
 * ```typescript
 * import createClient from 'aetherfy-vectors';
 *
 * const client = createClient({
 *   apiKey: 'afy_live_your_api_key_here'
 * });
 * ```
 */
export function createClient(
  config?: ConstructorParameters<typeof AetherfyVectorsClient>[0]
) {
  return new AetherfyVectorsClient(config);
}
