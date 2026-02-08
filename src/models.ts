/**
 * Data models and types for Aetherfy Vectors SDK
 */

/**
 * Distance metrics supported by Aetherfy Vectors
 */
export enum DistanceMetric {
  COSINE = 'Cosine',
  EUCLIDEAN = 'Euclidean',
  DOT = 'Dot',
  MANHATTAN = 'Manhattan',
}

/**
 * Vector configuration for collections
 */
export interface VectorConfig {
  /** Dimension size of vectors */
  size: number;
  /** Distance metric to use for similarity calculations */
  distance: DistanceMetric;
}

/**
 * Flexible vector configuration input (accepts string or enum for distance)
 * Used in public API methods for user convenience
 */
export interface VectorConfigInput {
  /** Dimension size of vectors */
  size: number;
  /** Distance metric to use for similarity calculations */
  distance: DistanceMetric | string;
}

/**
 * A point (vector) with optional metadata
 */
export interface Point {
  /** Unique identifier for the point */
  id: string | number;
  /** The vector data */
  vector: number[];
  /** Optional metadata associated with the point */
  payload?: Record<string, unknown>;
}

/**
 * Result from a similarity search
 */
export interface SearchResult {
  /** Point identifier */
  id: string | number;
  /** Similarity score */
  score: number;
  /** Optional metadata if requested */
  payload?: Record<string, unknown>;
  /** Optional vector data if requested */
  vector?: number[];
}

/**
 * Collection information
 */
export interface Collection {
  /** Collection name */
  name: string;
  /** Collection description (optional) */
  description?: string;
  /** Vector configuration */
  config: VectorConfig;
  /** Number of points in collection (if available) */
  pointsCount?: number;
  /** Collection status */
  status?: string;
}

/**
 * Performance analytics data
 */
export interface PerformanceAnalytics {
  /** Cache hit rate percentage */
  cacheHitRate: number;
  /** Average latency in milliseconds */
  avgLatencyMs: number;
  /** Requests per second */
  requestsPerSecond: number;
  /** List of active regions */
  activeRegions: string[];
  /** Performance metrics by region */
  regionPerformance: Record<string, Record<string, number>>;
  /** Total number of requests (optional) */
  totalRequests?: number;
  /** Error rate percentage (optional) */
  errorRate?: number;
}

/**
 * Analytics data for a specific collection
 */
export interface CollectionAnalytics {
  /** Collection name */
  collectionName: string;
  /** Total number of points */
  totalPoints: number;
  /** Number of search requests */
  searchRequests: number;
  /** Average search latency in milliseconds */
  avgSearchLatencyMs: number;
  /** Cache hit rate percentage */
  cacheHitRate: number;
  /** Top performing regions */
  topRegions: string[];
  /** Storage size in MB (optional) */
  storageSizeMb?: number;
}

/**
 * Usage statistics for the account
 */
export interface UsageStats {
  /** Current number of collections */
  currentCollections: number;
  /** Maximum allowed collections */
  maxCollections: number;
  /** Current number of points across all collections */
  currentPoints: number;
  /** Maximum allowed points */
  maxPoints: number;
  /** Requests made this month */
  requestsThisMonth: number;
  /** Maximum requests per month */
  maxRequestsPerMonth: number;
  /** Storage used in MB */
  storageUsedMb: number;
  /** Maximum storage allowed in MB */
  maxStorageMb: number;
  /** Account plan name */
  planName: string;
}

/**
 * Filter conditions for queries
 */
export interface Filter {
  /** Conditions that must be true */
  must?: Array<Record<string, unknown>>;
  /** Conditions that must not be true */
  mustNot?: Array<Record<string, unknown>>;
  /** Conditions where at least one should be true */
  should?: Array<Record<string, unknown>>;
}

/**
 * Options for search operations
 */
export interface SearchOptions {
  /** Maximum number of results to return */
  limit?: number;
  /** Number of results to skip */
  offset?: number;
  /** Filter conditions */
  queryFilter?: Filter;
  /** Include payload in results */
  withPayload?: boolean;
  /** Include vector data in results */
  withVectors?: boolean;
  /** Minimum similarity score threshold */
  scoreThreshold?: number;
}

/**
 * Options for point retrieval
 */
export interface RetrieveOptions {
  /** Include payload in results */
  withPayload?: boolean;
  /** Include vector data in results */
  withVectors?: boolean;
}

/**
 * Options for count operations
 */
export interface CountOptions {
  /** Filter conditions for counting */
  countFilter?: Filter;
  /** Use exact counting (slower but precise) */
  exact?: boolean;
}

/**
 * Batch operation result
 */
export interface BatchResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Number of items processed */
  processed: number;
  /** Operation details or error messages */
  details?: string[];
}

/**
 * Configuration options for the main client
 */
export interface ClientConfig {
  /** API key for authentication */
  apiKey?: string;
  /** Custom endpoint URL */
  endpoint?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /**
   * Enable HTTP connection pooling for better performance.
   * Defaults to true in Node.js environments.
   * Set to false to disable (useful for testing with HTTP interceptors).
   * @internal
   */
  enableConnectionPooling?: boolean;
  /**
   * Workspace name for multi-agent coordination.
   * - Set to 'auto' to auto-detect from AETHERFY_WORKSPACE environment variable
   * - Set to a string to use a specific workspace
   * - Leave undefined for no workspace (collections are not namespaced)
   *
   * When set, all collection names are automatically prefixed with the workspace.
   * Example: workspace='invoice-pipeline', collection='documents' → 'invoice-pipeline/documents'
   */
  workspace?: string | 'auto';
}

/**
 * Response wrapper for API calls
 */
export interface ApiResponse<T> {
  /** Response data */
  data: T;
  /** Response status */
  status: 'success' | 'error';
  /** Optional message */
  message?: string;
  /** Request ID for tracking */
  requestId?: string;
}

/**
 * Pagination information
 */
export interface PaginationInfo {
  /** Current page/offset */
  offset: number;
  /** Page size/limit */
  limit: number;
  /** Total number of items (if known) */
  total?: number;
  /** Whether there are more items */
  hasMore?: boolean;
}

/**
 * Region information
 */
export interface RegionInfo {
  /** Region identifier */
  id: string;
  /** Region display name */
  name: string;
  /** Whether the region is active */
  active: boolean;
  /** Region latency metrics */
  latencyMs?: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Hit rate percentage */
  hitRate: number;
  /** Total cache hits */
  hits: number;
  /** Total cache misses */
  misses: number;
  /** Cache size information */
  size?: {
    used: number;
    available: number;
  };
}

/**
 * Top collection analytics entry
 */
export interface TopCollectionEntry {
  /** Collection name */
  collectionName: string;
  /** Metric value (requests, points, searches, storage, etc.) */
  value: number;
  /** Optional additional metrics */
  [key: string]: string | number;
}

/**
 * Supported data types for schema validation
 */
export type DataType =
  | 'string'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'null'
  | 'array'
  | 'object';

/**
 * Schema enforcement modes
 */
export type EnforcementMode = 'off' | 'warn' | 'strict';

/**
 * Field definition in a schema
 */
export interface FieldDefinition {
  /** Data type of the field */
  type: DataType;
  /** Whether the field is required */
  required: boolean;
  /** Element type for arrays */
  elementType?: DataType;
  /** Nested field definitions for objects */
  fields?: Record<string, FieldDefinition>;
}

/**
 * Schema definition for a collection's payload structure
 */
export interface Schema {
  /** Field definitions */
  fields: Record<string, FieldDefinition>;
}

/**
 * Validation error for a single field
 */
export interface FieldValidationError {
  /** Field path (e.g., "price" or "metadata.source") */
  field: string;
  /** Error code */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Expected type/value */
  expected?: string;
  /** Actual type/value */
  actual?: string;
}

/**
 * Validation errors for a single vector
 */
export interface VectorValidationError {
  /** Index of the vector in the batch */
  index: number;
  /** ID of the vector */
  id: string | number;
  /** List of validation errors */
  errors: FieldValidationError[];
}

/**
 * Field analysis result
 */
export interface FieldAnalysis {
  /** Field presence rate (0.0 to 1.0) */
  presence: number;
  /** Type distribution (type name -> percentage) */
  types: Record<string, number>;
  /** Element types for arrays */
  elementTypes?: Record<string, number>;
  /** Nested field analysis for objects */
  nested?: Record<string, FieldAnalysis>;
  /** List of warnings (e.g., MIXED_TYPES, LOW_PRESENCE) */
  warnings: string[];
  /** Sample values per type */
  samples?: Record<string, unknown>;
}

/**
 * Schema analysis result
 */
export interface AnalysisResult {
  /** Collection name */
  collection: string;
  /** Number of points sampled */
  sampleSize: number;
  /** Total points in collection */
  totalPoints: number;
  /** Field analysis results */
  fields: Record<string, FieldAnalysis>;
  /** Suggested schema based on analysis */
  suggestedSchema: Schema;
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * Schema data with metadata
 */
export interface SchemaData {
  /** Schema definition */
  schema: Schema;
  /** Enforcement mode */
  enforcementMode: EnforcementMode;
  /** ETag for cache synchronization */
  etag: string;
}

/** Response from setSchema operation */
export interface SchemaResponse {
  /** ETag of the created/updated schema */
  etag: string;
}
