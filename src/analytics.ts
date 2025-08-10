import { HttpClient } from './http/client';
import {
  PerformanceAnalytics,
  CollectionAnalytics,
  UsageStats,
  CacheStats,
  RegionInfo,
  TopCollectionEntry,
} from './models';
import { createErrorFromResponse } from './exceptions';

/**
 * Analytics client for monitoring and performance metrics
 *
 * Provides detailed insights into your Aetherfy Vectors usage,
 * performance, and regional distribution.
 */
export class AnalyticsClient {
  private httpClient: HttpClient;
  private baseUrl: string;
  private authHeaders: Record<string, string>;

  constructor(
    httpClient: HttpClient,
    baseUrl: string,
    authHeaders: Record<string, string>
  ) {
    this.httpClient = httpClient;
    this.baseUrl = baseUrl;
    this.authHeaders = authHeaders;
  }

  /**
   * Get global performance analytics
   *
   * @param timeRange - Time range for analytics ('1h', '24h', '7d', '30d')
   * @param region - Optional specific region to analyze
   * @returns Promise that resolves to performance analytics
   *
   * @example
   * ```typescript
   * const analytics = await client.getPerformanceAnalytics('24h');
   * console.log(`Cache hit rate: ${analytics.cacheHitRate}%`);
   * console.log(`Average latency: ${analytics.avgLatencyMs}ms`);
   * ```
   */
  async getPerformanceAnalytics(
    timeRange: string = '24h',
    region?: string
  ): Promise<PerformanceAnalytics> {
    try {
      const params = new URLSearchParams({
        time_range: timeRange,
        ...(region && { region }),
      });

      const response = await this.httpClient.get<PerformanceAnalytics>(
        `${this.baseUrl}/analytics/performance?${params}`
      );

      return response.data;
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Get analytics for a specific collection
   *
   * @param collectionName - Name of the collection
   * @param timeRange - Time range for analytics
   * @returns Promise that resolves to collection analytics
   *
   * @example
   * ```typescript
   * const stats = await client.getCollectionAnalytics('products', '7d');
   * console.log(`Total points: ${stats.totalPoints}`);
   * console.log(`Search requests: ${stats.searchRequests}`);
   * ```
   */
  async getCollectionAnalytics(
    collectionName: string,
    timeRange: string = '24h'
  ): Promise<CollectionAnalytics> {
    try {
      const params = new URLSearchParams({
        time_range: timeRange,
      });

      const response = await this.httpClient.get<CollectionAnalytics>(
        `${this.baseUrl}/analytics/collections/${encodeURIComponent(collectionName)}?${params}`
      );

      return response.data;
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Get account usage statistics
   *
   * @returns Promise that resolves to usage stats
   *
   * @example
   * ```typescript
   * const usage = await client.getUsageStats();
   * if (usage.currentPoints > usage.maxPoints * 0.8) {
   *   console.warn('Approaching point limit');
   * }
   * ```
   */
  async getUsageStats(): Promise<UsageStats> {
    try {
      const response = await this.httpClient.get<UsageStats>(
        `${this.baseUrl}/analytics/usage`
      );

      return response.data;
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Get regional performance breakdown
   *
   * @param timeRange - Time range for analytics
   * @returns Promise that resolves to region performance data
   */
  async getRegionPerformance(
    timeRange: string = '24h'
  ): Promise<Record<string, Record<string, number>>> {
    try {
      const params = new URLSearchParams({
        time_range: timeRange,
      });

      const response = await this.httpClient.get<{
        regions: Record<string, Record<string, number>>;
      }>(`${this.baseUrl}/analytics/regions?${params}`);

      return response.data.regions || {};
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Get cache analytics and statistics
   *
   * @param timeRange - Time range for analytics
   * @returns Promise that resolves to cache analytics
   */
  async getCacheAnalytics(timeRange: string = '24h'): Promise<CacheStats> {
    try {
      const params = new URLSearchParams({
        time_range: timeRange,
      });

      const response = await this.httpClient.get<CacheStats>(
        `${this.baseUrl}/analytics/cache?${params}`
      );

      return response.data;
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Get top collections by specified metric
   *
   * @param metric - Metric to sort by ('requests', 'points', 'searches', 'storage')
   * @param timeRange - Time range for analytics
   * @param limit - Maximum number of collections to return
   * @returns Promise that resolves to top collections
   */
  async getTopCollections(
    metric: string = 'requests',
    timeRange: string = '24h',
    limit: number = 10
  ): Promise<TopCollectionEntry[]> {
    try {
      const params = new URLSearchParams({
        metric,
        time_range: timeRange,
        limit: limit.toString(),
      });

      const response = await this.httpClient.get<{
        collections: TopCollectionEntry[];
      }>(`${this.baseUrl}/analytics/collections/top?${params}`);

      return response.data.collections || [];
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Get available regions and their status
   *
   * @returns Promise that resolves to region information
   */
  async getRegions(): Promise<RegionInfo[]> {
    try {
      const response = await this.httpClient.get<{ regions: RegionInfo[] }>(
        `${this.baseUrl}/analytics/regions/info`
      );

      return response.data.regions || [];
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Handle errors from analytics API calls
   */
  private handleError(error: unknown): Error {
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      'responseData' in error
    ) {
      const httpError = error as {
        status: number;
        responseData: unknown;
        statusText: string;
        requestId?: string;
      };
      return createErrorFromResponse(
        httpError.responseData as Record<string, unknown>,
        httpError.status,
        httpError.statusText,
        httpError.requestId
      );
    }

    const message =
      error instanceof Error ? error.message : 'Analytics request failed';
    return new Error(message);
  }
}
