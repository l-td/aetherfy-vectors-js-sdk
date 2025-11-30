import { HttpClient } from './http/client';
import { APIKeyManager } from './auth';
import { AnalyticsClient } from './analytics';
import {
  VectorConfig,
  Point,
  SearchResult,
  Collection,
  SearchOptions,
  RetrieveOptions,
  CountOptions,
  Filter,
  PerformanceAnalytics,
  CollectionAnalytics,
  UsageStats,
  ClientConfig,
  DistanceMetric,
  Schema,
  SchemaData,
  EnforcementMode,
  AnalysisResult,
  FieldAnalysis,
} from './models';
import {
  AetherfyVectorsError,
  ValidationError,
  NetworkError,
  SchemaValidationError,
  createErrorFromResponse,
  isRetryableError,
} from './exceptions';
import { retryWithBackoff } from './utils';
import { validateVectors } from './schema';

/**
 * Aetherfy Vectors JavaScript SDK
 *
 * Global vector database client with automatic replication,
 * intelligent caching, and worldwide sub-50ms latency.
 *
 * Works in both Node.js and browser environments.
 *
 * @example
 * ```typescript
 * const client = new AetherfyVectorsClient({
 *   apiKey: 'afy_live_your_api_key_here'
 * });
 *
 * // Create a collection
 * await client.createCollection('products', {
 *   size: 128,
 *   distance: DistanceMetric.COSINE
 * });
 *
 * // Add points
 * await client.upsert('products', [
 *   {
 *     id: 'product_1',
 *     vector: [0.1, 0.2, ...], // 128-dimensional
 *     payload: { name: 'Product A' }
 *   }
 * ]);
 *
 * // Search
 * const results = await client.search('products', queryVector, {
 *   limit: 10,
 *   withPayload: true
 * });
 * ```
 */
export class AetherfyVectorsClient {
  private static readonly DEFAULT_ENDPOINT = 'https://vectors.aetherfy.com';
  private static readonly DEFAULT_TIMEOUT = 30000;

  private httpClient: HttpClient;
  private authManager: APIKeyManager;
  private analytics: AnalyticsClient;
  private endpoint: string;
  private schemaCache: Map<
    string,
    { size: number; distance: string; etag: string }
  >;
  private payloadSchemaCache: Map<string, SchemaData | null>;

  /**
   * Create a new Aetherfy Vectors client
   *
   * @param config - Configuration options
   */
  constructor(config: ClientConfig = {}) {
    // Initialize authentication
    const apiKey = APIKeyManager.resolveApiKey(config.apiKey);
    this.authManager = new APIKeyManager(apiKey);

    // Set up endpoint and HTTP client
    this.endpoint = config.endpoint || AetherfyVectorsClient.DEFAULT_ENDPOINT;
    this.httpClient = new HttpClient({
      timeout: config.timeout || AetherfyVectorsClient.DEFAULT_TIMEOUT,
      defaultHeaders: this.authManager.getAuthHeaders(),
      enableConnectionPooling: config.enableConnectionPooling,
    });

    // Initialize schema cache for ETag-based validation
    this.schemaCache = new Map();

    // Initialize payload schema cache
    this.payloadSchemaCache = new Map();

    // Initialize analytics client
    this.analytics = new AnalyticsClient(
      this.httpClient,
      this.endpoint,
      this.authManager.getAuthHeaders()
    );
  }

  // Collection Management

  /**
   * Create a new collection with specified vector configuration
   *
   * @param name - Collection name (must be unique)
   * @param vectorsConfig - Vector configuration or legacy config object
   * @param description - Optional collection description (max 500 characters)
   * @returns Promise that resolves to true if successful
   *
   * @example
   * ```typescript
   * await client.createCollection('my-collection', {
   *   size: 384,
   *   distance: DistanceMetric.COSINE
   * }, 'My collection for semantic search');
   * ```
   */
  async createCollection(
    name: string,
    vectorsConfig: VectorConfig | Record<string, unknown>,
    description?: string
  ): Promise<boolean> {
    this.validateCollectionName(name);

    const config = this.normalizeVectorConfig(vectorsConfig);

    try {
      const response = await this.executeWithRetry(async () =>
        this.httpClient.post(`${this.endpoint}/collections`, {
          name,
          vectors: config,
          description: description || null,
        })
      );

      return response.status === 200 || response.status === 201;
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Delete a collection and all its data
   *
   * @param name - Collection name to delete
   * @returns Promise that resolves to true if successful
   */
  async deleteCollection(name: string): Promise<boolean> {
    this.validateCollectionName(name);

    try {
      const response = await this.httpClient.delete(
        `${this.endpoint}/collections/${encodeURIComponent(name)}`
      );

      return response.status === 200 || response.status === 204;
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Get list of all collections
   *
   * @returns Promise that resolves to array of collections
   */
  async getCollections(): Promise<Collection[]> {
    try {
      const response = await this.httpClient.get<{ collections: Collection[] }>(
        `${this.endpoint}/collections`
      );

      return response.data.collections || [];
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Check if a collection exists
   *
   * @param name - Collection name to check
   * @returns Promise that resolves to true if collection exists
   */
  async collectionExists(name: string): Promise<boolean> {
    this.validateCollectionName(name);

    try {
      await this.httpClient.get(
        `${this.endpoint}/collections/${encodeURIComponent(name)}`
      );
      return true;
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        ('status' in error || 'statusCode' in error)
      ) {
        const httpError = error as { status?: number; statusCode?: number };
        if (httpError.status === 404 || httpError.statusCode === 404) {
          return false;
        }
      }
      throw this.handleError(error);
    }
  }

  /**
   * Get information about a specific collection
   *
   * @param name - Collection name
   * @returns Promise that resolves to collection information
   */
  async getCollection(name: string): Promise<Collection> {
    this.validateCollectionName(name);

    try {
      const response = await this.httpClient.get<{ result: Collection }>(
        `${this.endpoint}/collections/${encodeURIComponent(name)}`
      );

      return response.data.result;
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  // Point Operations

  /**
   * Insert or update points in a collection
   *
   * @param collectionName - Name of the collection
   * @param points - Array of points to upsert
   * @returns Promise that resolves to true if successful
   *
   * @example
   * ```typescript
   * await client.upsert('products', [
   *   {
   *     id: 'product_1',
   *     vector: [0.1, 0.2, 0.3, ...],
   *     payload: { name: 'Product A', category: 'electronics' }
   *   }
   * ]);
   * ```
   */
  async upsert(
    collectionName: string,
    points: Point[] | Record<string, unknown>[]
  ): Promise<boolean> {
    this.validateCollectionName(collectionName);
    this.validateBatchSize(points);

    // Get vector schema (from cache or fetch)
    let schema = this.getCachedSchema(collectionName);
    if (!schema) {
      schema = await this.fetchAndCacheSchema(collectionName);
    }

    // Validate vector dimensions
    const expectedDim = schema.size;
    for (const point of points) {
      const typedPoint = point as Record<string, unknown>;
      const vector = typedPoint.vector;
      if (!vector || !Array.isArray(vector)) {
        throw new ValidationError('Each point must have a vector array');
      }

      if (vector.length !== expectedDim) {
        throw new ValidationError(
          `Vector dimension mismatch: expected ${expectedDim}, got ${vector.length}`
        );
      }
    }

    // Get payload schema for validation (if exists)
    const payloadSchemaData = await this.getCachedPayloadSchema(collectionName);

    // Client-side payload validation
    if (payloadSchemaData && payloadSchemaData.schema) {
      const enforcementMode = payloadSchemaData.enforcementMode || 'off';

      // Only validate if enforcement is not 'off'
      if (enforcementMode !== 'off') {
        const validationErrors = validateVectors(
          points,
          payloadSchemaData.schema
        );
        if (validationErrors.length > 0) {
          // Only raise error in strict mode
          if (enforcementMode === 'strict') {
            throw new SchemaValidationError(validationErrors);
          }
          // In warn mode, just allow the request to proceed
          // (warnings would be logged client-side if we had a logger)
        }
      }
    }

    const formattedPoints = this.formatPointsForUpsert(points);

    try {
      // Add If-Match headers with ETags
      const headers: Record<string, string> = {};
      if (schema.etag) {
        headers['If-Match'] = schema.etag;
      }
      // Payload schema ETag overrides vector schema ETag
      if (payloadSchemaData && payloadSchemaData.etag) {
        headers['If-Match'] = payloadSchemaData.etag;
      }

      const response = await this.executeWithRetry(async () =>
        this.httpClient.put(
          `${this.endpoint}/collections/${encodeURIComponent(collectionName)}/points`,
          { points: formattedPoints },
          headers
        )
      );

      return response.status === 200;
    } catch (error: unknown) {
      // Handle specific HTTP error statuses from HttpClient
      if (error && typeof error === 'object' && 'status' in error) {
        const httpError = error as {
          status: number;
          responseData?: Record<string, unknown>;
        };

        // Handle 412 Precondition Failed (schema changed)
        if (httpError.status === 412) {
          this.clearSchemaCache(collectionName);
          this.payloadSchemaCache.delete(collectionName);

          // Fetch updated schemas and re-validate
          let updatedPayloadSchema: SchemaData | null = null;
          try {
            updatedPayloadSchema =
              await this.getCachedPayloadSchema(collectionName);
            if (updatedPayloadSchema && updatedPayloadSchema.schema) {
              const enforcementMode =
                updatedPayloadSchema.enforcementMode || 'off';
              if (enforcementMode !== 'off') {
                const validationErrors = validateVectors(
                  points,
                  updatedPayloadSchema.schema
                );
                if (
                  validationErrors.length > 0 &&
                  enforcementMode === 'strict'
                ) {
                  throw new SchemaValidationError(validationErrors);
                }
              }
            }
          } catch (schemaError) {
            if (schemaError instanceof SchemaValidationError) {
              throw schemaError;
            }
            // Ignore other errors during schema refresh
          }

          // Retry the upsert with updated schemas
          try {
            const updatedVectorSchema =
              await this.fetchAndCacheSchema(collectionName);
            const retryHeaders: Record<string, string> = {};
            if (updatedVectorSchema.etag) {
              retryHeaders['If-Match'] = updatedVectorSchema.etag;
            }
            if (updatedPayloadSchema && updatedPayloadSchema.etag) {
              retryHeaders['If-Match'] = updatedPayloadSchema.etag;
            }

            const response = await this.httpClient.put(
              `${this.endpoint}/collections/${encodeURIComponent(collectionName)}/points`,
              { points: formattedPoints },
              retryHeaders
            );

            return response.status === 200;
          } catch {
            // If retry also fails, raise the original 412 error
            throw new ValidationError(
              `Collection schema has changed for '${collectionName}'. Please retry your request.`
            );
          }
        }

        // Handle 400 (validation error from backend)
        if (httpError.status === 400) {
          const responseData = httpError.responseData;
          // Try nested error object first, then flat error/message
          const errorObj = responseData?.error as
            | { message?: string }
            | undefined;
          const errorMessage =
            errorObj?.message ||
            (responseData?.message as string) ||
            (responseData?.error as string) ||
            'Validation error occurred';
          throw new ValidationError(errorMessage);
        }

        // Handle 500+ (server errors)
        if (httpError.status >= 500) {
          const responseData = httpError.responseData;
          const errorObj = responseData?.error as
            | { message?: string }
            | undefined;
          const errorMessage =
            errorObj?.message ||
            (responseData?.message as string) ||
            'Unknown server error';
          throw new AetherfyVectorsError(
            `Server error occurred: ${errorMessage}`
          );
        }
      }

      throw this.handleError(error);
    }
  }

  /**
   * Delete points from a collection
   *
   * @param collectionName - Name of the collection
   * @param pointsSelector - Array of point IDs or filter conditions
   * @returns Promise that resolves to true if successful
   */
  async delete(
    collectionName: string,
    pointsSelector: (string | number)[] | Filter
  ): Promise<boolean> {
    this.validateCollectionName(collectionName);

    const isFilter = !Array.isArray(pointsSelector);
    const body = isFilter
      ? { filter: pointsSelector }
      : { points: pointsSelector };

    try {
      const response = await this.httpClient.post(
        `${this.endpoint}/collections/${encodeURIComponent(collectionName)}/points/delete`,
        body
      );

      return response.status === 200;
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Retrieve points by their IDs
   *
   * @param collectionName - Name of the collection
   * @param ids - Array of point IDs to retrieve
   * @param options - Retrieval options
   * @returns Promise that resolves to array of points
   */
  async retrieve(
    collectionName: string,
    ids: (string | number)[],
    options: RetrieveOptions = {}
  ): Promise<Point[]> {
    this.validateCollectionName(collectionName);

    if (!ids.length) {
      return [];
    }

    try {
      const response = await this.httpClient.post<{
        result: Point[];
      }>(
        `${this.endpoint}/collections/${encodeURIComponent(collectionName)}/points`,
        {
          ids,
          with_payload: options.withPayload ?? true,
          with_vectors: options.withVectors ?? false,
        }
      );

      return response.data.result || [];
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  // Search Operations

  /**
   * Perform similarity search in a collection
   *
   * @param collectionName - Name of the collection to search
   * @param queryVector - Query vector for similarity search
   * @param options - Search options
   * @returns Promise that resolves to search results
   *
   * @example
   * ```typescript
   * const results = await client.search('products', queryVector, {
   *   limit: 10,
   *   withPayload: true,
   *   scoreThreshold: 0.7
   * });
   * ```
   */
  async search(
    collectionName: string,
    queryVector: number[],
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    this.validateCollectionName(collectionName);
    this.validateVector(queryVector);

    try {
      const response = await this.executeWithRetry(async () =>
        this.httpClient.post<{ result: SearchResult[] }>(
          `${this.endpoint}/collections/${encodeURIComponent(collectionName)}/points/search`,
          {
            vector: queryVector,
            limit: options.limit ?? 10,
            offset: options.offset ?? 0,
            filter: options.queryFilter,
            with_payload: options.withPayload ?? true,
            with_vector: options.withVectors ?? false,
            score_threshold: options.scoreThreshold,
          }
        )
      );

      return response.data.result || [];
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Count points in a collection
   *
   * @param collectionName - Name of the collection
   * @param options - Count options
   * @returns Promise that resolves to point count
   */
  async count(
    collectionName: string,
    options: CountOptions = {}
  ): Promise<number> {
    this.validateCollectionName(collectionName);

    try {
      const response = await this.httpClient.post<{
        result: { count: number };
      }>(
        `${this.endpoint}/collections/${encodeURIComponent(collectionName)}/points/count`,
        {
          filter: options.countFilter,
          exact: options.exact ?? false,
        }
      );

      return response.data.result.count;
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  // Analytics Methods

  /**
   * Get performance analytics
   *
   * @param timeRange - Time range for analytics (e.g., '24h', '7d')
   * @param region - Optional specific region to analyze
   * @returns Promise that resolves to performance analytics
   */
  async getPerformanceAnalytics(
    timeRange: string = '24h',
    region?: string
  ): Promise<PerformanceAnalytics> {
    return this.analytics.getPerformanceAnalytics(timeRange, region);
  }

  /**
   * Get analytics for a specific collection
   *
   * @param collectionName - Name of the collection
   * @param timeRange - Time range for analytics
   * @returns Promise that resolves to collection analytics
   */
  async getCollectionAnalytics(
    collectionName: string,
    timeRange: string = '24h'
  ): Promise<CollectionAnalytics> {
    this.validateCollectionName(collectionName);
    return this.analytics.getCollectionAnalytics(collectionName, timeRange);
  }

  /**
   * Get account usage statistics
   *
   * @returns Promise that resolves to usage stats
   */
  async getUsageStats(): Promise<UsageStats> {
    return this.analytics.getUsageStats();
  }

  // Utility Methods

  /**
   * Test the connection to Aetherfy Vectors
   *
   * @returns Promise that resolves to true if connection is successful
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up resources (if needed)
   *
   * @returns Promise that resolves when cleanup is complete
   */
  async dispose(): Promise<void> {
    // Cleanup resources if needed in the future
  }

  /**
   * Clear schema cache for a collection or all collections
   *
   * @param collectionName - Name of collection to clear, or undefined to clear all
   */
  clearSchemaCache(collectionName?: string): void {
    if (collectionName) {
      this.schemaCache.delete(collectionName);
    } else {
      this.schemaCache.clear();
    }
  }

  // Private helper methods

  private getCachedSchema(
    collectionName: string
  ): { size: number; distance: string; etag: string } | undefined {
    return this.schemaCache.get(collectionName);
  }

  private async fetchAndCacheSchema(
    collectionName: string
  ): Promise<{ size: number; distance: string; etag: string }> {
    const response = await this.httpClient.get<{
      result: {
        config: {
          params: {
            vectors: {
              size: number;
              distance: string;
            };
          };
        };
      };
      schema_version: string;
    }>(`${this.endpoint}/collections/${encodeURIComponent(collectionName)}`);

    const result = response.data.result;
    const schemaVersion = response.data.schema_version;
    const vectorConfig = result?.config?.params?.vectors;

    if (!vectorConfig || !vectorConfig.size) {
      throw new ValidationError(
        'Invalid collection schema received from server'
      );
    }

    const schema = {
      size: vectorConfig.size,
      distance: vectorConfig.distance,
      etag: schemaVersion,
    };

    this.schemaCache.set(collectionName, schema);
    return schema;
  }

  private validateCollectionName(name: string): void {
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
  }

  private validateVector(vector: number[]): void {
    if (!Array.isArray(vector)) {
      throw new ValidationError('Vector must be an array of numbers');
    }

    if (vector.length === 0) {
      throw new ValidationError('Vector cannot be empty');
    }

    if (!vector.every(val => typeof val === 'number' && !isNaN(val))) {
      throw new ValidationError('Vector must contain only valid numbers');
    }
  }

  private validateBatchSize(points: unknown[]): void {
    if (!Array.isArray(points)) {
      throw new ValidationError('Points must be an array');
    }

    if (points.length === 0) {
      throw new ValidationError('Points array cannot be empty');
    }

    if (points.length > 1000) {
      throw new ValidationError('Batch size cannot exceed 1000 points');
    }
  }

  private normalizeVectorConfig(
    config: VectorConfig | Record<string, unknown>
  ): VectorConfig {
    if (!config || typeof config !== 'object') {
      throw new ValidationError('Vector configuration must be an object');
    }

    const size = config.size;
    const distance = config.distance;

    if (!size || typeof size !== 'number' || size <= 0) {
      throw new ValidationError('Vector size must be a positive number');
    }

    if (!distance || typeof distance !== 'string') {
      throw new ValidationError('Distance metric must be specified');
    }

    // Normalize distance metric to match Qdrant's expected format (capitalized)
    const distanceMap: Record<string, DistanceMetric> = {
      cosine: DistanceMetric.COSINE,
      euclidean: DistanceMetric.EUCLIDEAN,
      euclid: DistanceMetric.EUCLIDEAN,
      dot: DistanceMetric.DOT,
      manhattan: DistanceMetric.MANHATTAN,
    };

    const normalizedDistance = distanceMap[distance.toLowerCase()] || distance;

    return { size, distance: normalizedDistance } as VectorConfig;
  }

  private formatPointsForUpsert(
    points: (Point | Record<string, unknown>)[]
  ): Point[] {
    return points.map(point => {
      if (
        !point ||
        typeof point !== 'object' ||
        !('id' in point) ||
        point.id === null ||
        point.id === undefined
      ) {
        throw new ValidationError('Each point must have an id');
      }

      if (
        !('vector' in point) ||
        !point.vector ||
        !Array.isArray(point.vector)
      ) {
        throw new ValidationError('Each point must have a vector array');
      }

      this.validateVector(point.vector);

      return {
        id: point.id as string | number,
        vector: point.vector as number[],
        payload: (point.payload as Record<string, unknown>) || {},
      };
    });
  }

  private handleError(error: unknown): AetherfyVectorsError {
    if (error instanceof AetherfyVectorsError) {
      return error;
    }

    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      'responseData' in error
    ) {
      const httpError = error as {
        status: number;
        responseData: Record<string, unknown>;
        statusText: string;
        requestId?: string;
      };
      return createErrorFromResponse(
        httpError.responseData,
        httpError.status,
        httpError.statusText,
        httpError.requestId
      );
    }

    // Check if it's a network error (timeout, connection errors, etc.)
    if (error instanceof Error) {
      const message = error.message;
      if (
        message.includes('Network error') ||
        message.includes('timeout') ||
        message.includes('ECONNRESET') ||
        message.includes('ETIMEDOUT') ||
        message.includes('ECONNABORTED')
      ) {
        return new NetworkError(message);
      }
    }

    const message =
      error instanceof Error ? error.message : 'Unknown error occurred';
    return new AetherfyVectorsError(message);
  }

  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    return retryWithBackoff(operation, {
      maxRetries: 3,
      retryCondition: error => isRetryableError(error),
    });
  }

  // ==================== Schema Management Methods ====================

  /**
   * Get schema for a collection
   *
   * @param collectionName - Name of the collection
   * @returns Schema definition if exists, null otherwise
   *
   * @example
   * ```typescript
   * const schema = await client.getSchema('products');
   * if (schema) {
   *   console.log('Schema fields:', schema.fields);
   * }
   * ```
   */
  async getSchema(collectionName: string): Promise<Schema | null> {
    this.validateCollectionName(collectionName);

    // Check cache first
    if (this.payloadSchemaCache.has(collectionName)) {
      const cached = this.payloadSchemaCache.get(collectionName);
      return cached ? cached.schema : null;
    }

    try {
      const response = await this.httpClient.get(
        `${this.endpoint}/api/v1/schema/${encodeURIComponent(collectionName)}`
      );

      if (response.status === 404) {
        return null;
      }

      const data = response.data as {
        schema: Schema;
        enforcement_mode: EnforcementMode;
        etag: string;
      };

      // Cache it
      this.payloadSchemaCache.set(collectionName, {
        schema: data.schema,
        enforcementMode: data.enforcement_mode,
        etag: data.etag,
      });

      return data.schema;
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        error.status === 404
      ) {
        return null;
      }
      throw this.handleError(error);
    }
  }

  /**
   * Set or update schema for a collection
   *
   * @param collectionName - Name of the collection
   * @param schema - Schema definition
   * @param enforcementMode - Enforcement mode: 'off', 'warn', or 'strict'
   * @returns ETag of the new schema
   *
   * @example
   * ```typescript
   * const etag = await client.setSchema('products', {
   *   fields: {
   *     price: { type: 'integer', required: true },
   *     name: { type: 'string', required: true }
   *   }
   * }, 'strict');
   * ```
   */
  async setSchema(
    collectionName: string,
    schema: Schema,
    enforcementMode: EnforcementMode = 'off'
  ): Promise<string> {
    this.validateCollectionName(collectionName);

    const response = await this.httpClient.put(
      `${this.endpoint}/api/v1/schema/${encodeURIComponent(collectionName)}`,
      {
        schema,
        enforcement_mode: enforcementMode,
      }
    );

    const data = response.data as { etag: string };

    // Update cache
    this.payloadSchemaCache.set(collectionName, {
      schema,
      enforcementMode,
      etag: data.etag,
    });

    return data.etag;
  }

  /**
   * Delete schema from a collection
   *
   * @param collectionName - Name of the collection
   *
   * @example
   * ```typescript
   * await client.deleteSchema('products');
   * ```
   */
  async deleteSchema(collectionName: string): Promise<void> {
    this.validateCollectionName(collectionName);

    await this.httpClient.delete(
      `${this.endpoint}/api/v1/schema/${encodeURIComponent(collectionName)}`
    );

    // Clear cache
    this.payloadSchemaCache.delete(collectionName);
  }

  /**
   * Analyze collection data to understand payload structure
   *
   * @param collectionName - Name of the collection
   * @param sampleSize - Number of points to sample (default: 1000)
   * @returns Analysis result with field statistics and suggested schema
   *
   * @example
   * ```typescript
   * const analysis = await client.analyzeSchema('products', 1000);
   * console.log('Suggested schema:', analysis.suggestedSchema);
   * console.log('Field analysis:', analysis.fields);
   * ```
   */
  async analyzeSchema(
    collectionName: string,
    sampleSize: number = 1000
  ): Promise<AnalysisResult> {
    this.validateCollectionName(collectionName);

    const response = await this.httpClient.post(
      `${this.endpoint}/api/v1/schema/${encodeURIComponent(collectionName)}/analyze`,
      { sample_size: sampleSize }
    );

    const data = response.data as {
      collection: string;
      sample_size: number;
      total_points: number;
      fields: Record<string, FieldAnalysis>;
      suggested_schema: Schema;
      processing_time_ms: number;
    };

    return {
      collection: data.collection,
      sampleSize: data.sample_size,
      totalPoints: data.total_points,
      fields: data.fields,
      suggestedSchema: data.suggested_schema,
      processingTimeMs: data.processing_time_ms,
    };
  }

  /**
   * Force refresh of cached schema for a collection
   *
   * @param collectionName - Name of the collection
   *
   * @example
   * ```typescript
   * await client.refreshSchema('products');
   * ```
   */
  async refreshSchema(collectionName: string): Promise<void> {
    this.payloadSchemaCache.delete(collectionName);
    await this.getSchema(collectionName);
  }

  /**
   * Get cached schema data or fetch if not present
   *
   * @private
   * @param collectionName - Name of the collection
   * @returns Schema data or null
   */
  private async getCachedPayloadSchema(
    collectionName: string
  ): Promise<SchemaData | null> {
    // Check cache first
    if (this.payloadSchemaCache.has(collectionName)) {
      const cached = this.payloadSchemaCache.get(collectionName);
      return cached !== undefined ? cached : null;
    }

    // Try to fetch from server
    // Note: getSchema already caches the SchemaData internally
    try {
      const schema = await this.getSchema(collectionName);
      if (schema === null) {
        return null;
      }
      // getSchema already cached the SchemaData, so retrieve it from cache
      const cached = this.payloadSchemaCache.get(collectionName);
      return cached !== undefined ? cached : null;
    } catch {
      // On error, cache null to avoid retrying
      this.payloadSchemaCache.set(collectionName, null);
      return null;
    }
  }

  /**
   * Destroy the HTTP client and close all connections
   * Call this when you're done with the client to prevent hanging processes
   *
   * @example
   * ```typescript
   * const client = new AetherfyVectorsClient({ apiKey: 'afy_xxx' });
   * // ... use client ...
   * client.destroy(); // Clean up when done
   * ```
   */
  destroy(): void {
    this.httpClient.destroy();
  }
}
