import { HttpClient } from './http/client';
import {
  PerformanceAnalytics,
  UsageStats,
  CacheStats,
  RegionInfo,
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

  /** Build a fully-qualified analytics URL from the base host and a path. */
  private apiUrl(path: string): string {
    const base = this.baseUrl.replace(/\/$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${base}/api/v1${p}`;
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
        `${this.apiUrl('/analytics/performance')}?${params}`
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
        this.apiUrl('/analytics/usage')
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
      }>(`${this.apiUrl('/analytics/regions')}?${params}`);

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
        `${this.apiUrl('/analytics/cache')}?${params}`
      );

      return response.data;
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
        this.apiUrl('/analytics/regions/info')
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
