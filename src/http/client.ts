import {
  RequestConfig,
  HttpResponse,
  HttpClientOptions,
  ErrorResponse,
} from './types';
import axios, { AxiosInstance, AxiosError as AxiosErrorType } from 'axios';

// Type guard for axios errors
function isAxiosError(error: unknown): error is AxiosErrorType {
  return axios.isAxiosError(error);
}

/**
 * HTTP client with persistent connection pooling using axios.
 *
 * Connection pooling prevents TCP/TLS handshake overhead on every request,
 * significantly improving performance for server-to-server communication.
 */
export class HttpClient {
  private timeout: number;
  private defaultHeaders: Record<string, string>;
  private enableConnectionPooling: boolean;
  private axiosInstance: AxiosInstance;
  private httpAgent?: unknown;
  private httpsAgent?: unknown;

  constructor(options: HttpClientOptions = {}) {
    this.timeout = options.timeout || 30000;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'Aetherfy-Vectors-JS/1.0.0',
      ...options.defaultHeaders,
    };
    this.enableConnectionPooling = options.enableConnectionPooling ?? true;

    this.axiosInstance = this.createAxiosInstance();
  }

  /**
   * Create axios instance with persistent HTTP connection pooling
   */
  private createAxiosInstance(): AxiosInstance {
    const config: Record<string, unknown> = {
      timeout: this.timeout,
      headers: this.defaultHeaders,
      validateStatus: () => true, // Handle all status codes ourselves
    };

    // Add connection pooling for Node.js environment when enabled
    if (typeof process !== 'undefined' && process.versions?.node) {
      if (this.enableConnectionPooling) {
        const http = require('http');
        const https = require('https');

        this.httpAgent = new http.Agent({
          keepAlive: true,
          maxSockets: 50,
          maxFreeSockets: 10,
          timeout: 60000,
          keepAliveMsecs: 1000,
        });

        this.httpsAgent = new https.Agent({
          keepAlive: true,
          maxSockets: 50,
          maxFreeSockets: 10,
          timeout: 60000,
          keepAliveMsecs: 1000,
        });

        config.httpAgent = this.httpAgent;
        config.httpsAgent = this.httpsAgent;
      } else {
        // Explicitly set agents to undefined for test environments
        // This allows HTTP mocking libraries like nock to intercept requests
        config.httpAgent = undefined;
        config.httpsAgent = undefined;
      }
    }

    return axios.create(config);
  }

  /**
   * Destroy HTTP agents and close all connections
   * Call this when you're done with the client to prevent hanging processes
   * This method is idempotent and can be safely called multiple times
   */
  destroy(): void {
    if (
      this.httpAgent &&
      typeof this.httpAgent === 'object' &&
      'destroy' in this.httpAgent
    ) {
      (this.httpAgent as { destroy: () => void }).destroy();
      this.httpAgent = undefined;
    }
    if (
      this.httpsAgent &&
      typeof this.httpsAgent === 'object' &&
      'destroy' in this.httpsAgent
    ) {
      (this.httpsAgent as { destroy: () => void }).destroy();
      this.httpsAgent = undefined;
    }
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

    try {
      const response = await this.axiosInstance.request({
        url,
        method,
        headers: requestHeaders,
        data: body,
        timeout,
      });

      const data = response.data as T;

      if (response.status >= 400) {
        throw this.createError(
          data as unknown as ErrorResponse,
          response.status,
          response.statusText
        );
      }

      return {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers as Record<string, string>,
      };
    } catch (error: unknown) {
      // Check if this is our own HTTP error (created by createError)
      // These errors have both 'status' and 'responseData' properties
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        'responseData' in error
      ) {
        throw error;
      }

      // Check for network errors with error codes (e.g., ECONNRESET, ETIMEDOUT, etc.)
      // This needs to be checked before isAxiosError since mocks may use plain objects
      if (error && typeof error === 'object' && 'code' in error) {
        const errorObj = error as { code: string; message?: string };
        const message = errorObj.message || `Network error: ${errorObj.code}`;
        const networkError = new Error(
          message.includes('Network error')
            ? message
            : `Network error: ${message}`
        );
        Object.assign(networkError, { code: errorObj.code });
        throw networkError;
      }

      if (!isAxiosError(error)) {
        // For non-axios errors (like nock mock errors), format as network errors
        if (error instanceof Error) {
          const message = error.message.includes('Network error')
            ? error.message
            : `Network error: ${error.message}`;
          throw new Error(message);
        }
        throw new Error('Network error: Unknown network error');
      }

      // Axios-specific errors - format as network errors
      const message = error.message || 'Unknown network error';
      throw new Error(
        message.includes('Network error')
          ? message
          : `Network error: ${message}`
      );
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
