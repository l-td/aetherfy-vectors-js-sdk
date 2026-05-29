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
 * Body-aware timeout scaling. The default 30 s base is fine for small
 * requests, but a single upsert chunk can be 80 MB (MAX_REQUEST_BYTES in
 * utils/chunking.ts) and that doesn't fit in 30 s on residential / WAN
 * uplinks at 25 Mbps and below. Without scaling, the SDK aborts mid-
 * upload, retries 3 times, each timing out — the chunk lands in
 * PartialUpsertError.failed even though the origin would have accepted
 * it given enough time. Linear scaling above a small floor: cheap
 * requests stay snappy, large uploads get the runway they need.
 *
 * Tuned for ~25 Mbps as the floor — at that bandwidth, 1 MB takes
 * ~320 ms, so +1 s/MB gives ~3× margin for TLS, server processing, and
 * response wait. Faster links don't notice; slower links no longer abort.
 */
const TIMEOUT_THRESHOLD_BYTES = 5 * 1024 * 1024;
const TIMEOUT_PER_MB_OVER_THRESHOLD_MS = 1000;

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
   * POST request helper. Body-aware timeout: large bodies (search-with-
   * payload, scroll-with-filter, point retrieve) get extra time so a slow
   * uplink doesn't abort the request mid-upload.
   */
  async post<T>(
    url: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>> {
    const { data, bodyBytes } = this.prepareBody(body);
    const timeout = this.computeBodyAwareTimeout(bodyBytes);
    return this.request<T>({
      url,
      method: 'POST',
      body: data,
      headers,
      timeout,
    });
  }

  /**
   * PUT request helper. Body-aware timeout — see post(). The upsert path
   * is the primary motivator: an 80 MB chunk at 25 Mbps WAN upload needs
   * ~30 s just for the bytes; the default 30 s leaves no margin for
   * processing or response.
   */
  async put<T>(
    url: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>> {
    const { data, bodyBytes } = this.prepareBody(body);
    const timeout = this.computeBodyAwareTimeout(bodyBytes);
    return this.request<T>({
      url,
      method: 'PUT',
      body: data,
      headers,
      timeout,
    });
  }

  /**
   * DELETE request helper. Accepts an optional body — the API ships
   * endpoints (e.g. /points/payload) where DELETE carries the keys to
   * remove plus the points to remove them from. Browsers and Node both
   * support DELETE-with-body; axios passes it through `data`.
   */
  async delete<T>(
    url: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ url, method: 'DELETE', body, headers });
  }

  /**
   * Pre-serialize the body so we can size the timeout against the wire
   * bytes and avoid axios serializing again. JSON.stringify is O(N) but
   * unavoidable — axios would call it internally anyway. Strings and
   * binary buffers pass through unchanged.
   *
   * Returns { data: <what to pass to axios>, bodyBytes: <wire size> }.
   * On unserializable input (circular ref, etc.) falls back to handing
   * axios the original value with bodyBytes=0; the request still fires,
   * just with the base timeout.
   */
  private prepareBody(body: unknown): { data: unknown; bodyBytes: number } {
    if (body === undefined || body === null) {
      return { data: body, bodyBytes: 0 };
    }
    if (typeof body === 'string') {
      return { data: body, bodyBytes: Buffer.byteLength(body, 'utf8') };
    }
    if (body instanceof Uint8Array) {
      return { data: body, bodyBytes: body.byteLength };
    }
    try {
      const serialized = JSON.stringify(body);
      return {
        data: serialized,
        bodyBytes: Buffer.byteLength(serialized, 'utf8'),
      };
    } catch {
      return { data: body, bodyBytes: 0 };
    }
  }

  /**
   * Compute the timeout for a request given its body size. Bodies up to
   * TIMEOUT_THRESHOLD_BYTES use the base timeout unchanged; beyond that,
   * add TIMEOUT_PER_MB_OVER_THRESHOLD_MS for each megabyte over. See
   * the TIMEOUT_* constants near the top of this file for the rationale.
   */
  private computeBodyAwareTimeout(bodyBytes: number): number {
    if (bodyBytes <= TIMEOUT_THRESHOLD_BYTES) return this.timeout;
    const mbOver = Math.ceil(
      (bodyBytes - TIMEOUT_THRESHOLD_BYTES) / (1024 * 1024)
    );
    return this.timeout + mbOver * TIMEOUT_PER_MB_OVER_THRESHOLD_MS;
  }

  /**
   * Create appropriate error from response data
   */
  private createError(
    responseData: ErrorResponse,
    status: number,
    statusText: string
  ): Error {
    const errorField = responseData?.error;
    const nestedMessage =
      errorField && typeof errorField === 'object'
        ? errorField.message
        : errorField;
    const message =
      responseData?.message || nestedMessage || statusText || 'Unknown error';
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
