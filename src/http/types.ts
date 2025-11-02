/**
 * HTTP-related types for the Aetherfy Vectors SDK
 */

export interface RequestConfig {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export interface HttpResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface HttpClientOptions {
  timeout?: number;
  defaultHeaders?: Record<string, string>;
  /**
   * Enable HTTP connection pooling for better performance.
   * Defaults to true in Node.js environments.
   * Set to false to disable custom agents (useful for testing with interceptors).
   */
  enableConnectionPooling?: boolean;
}

export interface ErrorResponse {
  message?: string;
  error?: string;
  details?: Record<string, unknown>;
  requestId?: string;
}
