import crossFetch from 'cross-fetch';

/**
 * Get the appropriate fetch implementation at runtime
 * This allows for proper mocking in tests and dynamic resolution
 */
function getFetch(): typeof globalThis.fetch {
  // In tests, cross-fetch is mapped to jest-fetch-mock which respects our global mocks
  // In production, prioritize native implementations first
  if (typeof globalThis !== 'undefined' && globalThis.fetch) {
    return globalThis.fetch;
  }

  if (typeof window !== 'undefined' && window.fetch) {
    return window.fetch;
  }

  if (typeof global !== 'undefined' && (global as typeof globalThis).fetch) {
    return (global as typeof globalThis).fetch;
  }

  // Fall back to cross-fetch (which is mocked in tests)
  return crossFetch as typeof globalThis.fetch;
}
import {
  RequestConfig,
  HttpResponse,
  HttpClientOptions,
  ErrorResponse,
} from './types';

/**
 * Universal HTTP client that works in both Node.js and browser environments.
 * Uses cross-fetch for universal compatibility with consistent timeout handling
 * and error management.
 */
export class HttpClient {
  private timeout: number;
  private defaultHeaders: Record<string, string>;

  constructor(options: HttpClientOptions = {}) {
    this.timeout = options.timeout || 30000;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'Aetherfy-Vectors-JS/1.0.0',
      ...options.defaultHeaders,
    };
  }

  /**
   * Make an HTTP request with timeout handling and response parsing
   */
  async request<T>(config: RequestConfig): Promise<HttpResponse<T>> {
    const { url, method, headers = {}, body, timeout = this.timeout } = config;

    const requestHeaders = {
      ...this.defaultHeaders,
      ...headers,
    };

    // Set up AbortController for timeout handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Ensure timeout cleanup to prevent memory leaks
    if (timeoutId && typeof timeoutId === 'object' && 'unref' in timeoutId) {
      (timeoutId as NodeJS.Timeout).unref();
    }

    try {
      const fetchFn = getFetch();
      const response = await fetchFn(url, {
        method,
        headers: requestHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseHeaders = this.parseResponseHeaders(response.headers);
      let data: T;

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = (await response.text()) as T;
      }

      if (!response.ok) {
        throw this.createError(
          data as Record<string, unknown>,
          response.status,
          response.statusText
        );
      }

      return {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      };
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout`);
      }

      if (error instanceof Error && 'status' in error) {
        throw error;
      }

      const message =
        error instanceof Error ? error.message : 'Unknown network error';
      throw new Error(`Network error: ${message}`);
    }
  }

  /**
   * GET request helper
   */
  async get<T>(
    url: string,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ url, method: 'GET', headers });
  }

  /**
   * POST request helper
   */
  async post<T>(
    url: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ url, method: 'POST', body, headers });
  }

  /**
   * PUT request helper
   */
  async put<T>(
    url: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ url, method: 'PUT', body, headers });
  }

  /**
   * DELETE request helper
   */
  async delete<T>(
    url: string,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ url, method: 'DELETE', headers });
  }

  /**
   * Parse response headers from fetch Response
   */
  private parseResponseHeaders(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  /**
   * Create appropriate error from response data
   */
  private createError(
    responseData: ErrorResponse,
    status: number,
    statusText: string
  ): Error {
    const message =
      responseData?.message ||
      responseData?.error ||
      statusText ||
      'Unknown error';
    const error = new Error(message);
    Object.assign(error, {
      status,
      statusText,
      responseData,
      requestId: responseData?.requestId,
    });
    return error;
  }
}
