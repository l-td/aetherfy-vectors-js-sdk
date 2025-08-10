/**
 * Mock HTTP responses for testing
 */

// Types for mock functionality
interface MockRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  [key: string]: unknown;
}

interface MockCallRecord {
  url: string;
  options: MockRequestOptions;
}

type MockResponseData = Record<string, unknown> | unknown[];
type MockMatcher = (_url: string, _options: MockRequestOptions) => boolean;
type MockResponseValue = MockResponseData | (() => MockResponseData);

export function createMockResponse(
  data: MockResponseData,
  status: number = 200,
  statusText: string = 'OK',
  headers: Record<string, string> = {}
) {
  const responseHeaders = new Map(
    Object.entries({
      'content-type': 'application/json',
      ...headers,
    })
  );

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: responseHeaders,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

export function createMockErrorResponse(
  status: number,
  message: string,
  details: Record<string, unknown> = {}
) {
  return createMockResponse(
    { message, ...details },
    status,
    getStatusText(status)
  );
}

function getStatusText(status: number): string {
  const statusTexts: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };

  return statusTexts[status] || 'Unknown';
}

// Mock fetch implementation for tests
export class MockFetch {
  private responses: Array<{
    matcher: MockMatcher;
    response: MockResponseValue;
  }> = [];
  private callHistory: MockCallRecord[] = [];

  mockResponse(
    urlPattern: string | RegExp,
    method: string,
    response: MockResponseValue
  ) {
    const matcher = (url: string, options: MockRequestOptions) => {
      const urlMatches =
        typeof urlPattern === 'string'
          ? url.includes(urlPattern)
          : urlPattern.test(url);
      const methodMatches = options.method === method;
      return urlMatches && methodMatches;
    };

    this.responses.unshift({ matcher, response });
    return this;
  }

  mockGet(urlPattern: string | RegExp, response: MockResponseValue) {
    return this.mockResponse(urlPattern, 'GET', response);
  }

  mockPost(urlPattern: string | RegExp, response: MockResponseValue) {
    return this.mockResponse(urlPattern, 'POST', response);
  }

  mockPut(urlPattern: string | RegExp, response: MockResponseValue) {
    return this.mockResponse(urlPattern, 'PUT', response);
  }

  mockDelete(urlPattern: string | RegExp, response: MockResponseValue) {
    return this.mockResponse(urlPattern, 'DELETE', response);
  }

  async fetch(url: string, options: MockRequestOptions = {}) {
    this.callHistory.push({ url, options });

    const matchingResponse = this.responses.find(({ matcher }) =>
      matcher(url, options)
    );

    if (matchingResponse) {
      if (typeof matchingResponse.response === 'function') {
        return matchingResponse.response();
      }
      return matchingResponse.response;
    }

    // Default response for unmatched requests
    return createMockErrorResponse(404, 'Not Found');
  }

  getCallHistory() {
    return [...this.callHistory];
  }

  getLastCall() {
    return this.callHistory[this.callHistory.length - 1];
  }

  reset() {
    this.responses = [];
    this.callHistory = [];
  }

  expectCall(matcher: (_call: MockCallRecord) => boolean) {
    const matchingCall = this.callHistory.find(matcher);
    if (!matchingCall) {
      throw new Error('Expected call not found in history');
    }
    return matchingCall;
  }

  expectCalls(count: number) {
    if (this.callHistory.length !== count) {
      throw new Error(
        `Expected ${count} calls, but got ${this.callHistory.length}`
      );
    }
  }
}

// Predefined mock scenarios
export const mockScenarios = {
  // Successful operations
  successfulCollectionCreate: () =>
    createMockResponse({ success: true }, 201, 'Created'),
  successfulCollectionList: () =>
    createMockResponse({
      collections: [
        { name: 'test-collection', config: { size: 128, distance: 'Cosine' } },
      ],
    }),
  successfulSearch: () =>
    createMockResponse({
      result: [{ id: 'point_1', score: 0.95, payload: { name: 'Test Item' } }],
    }),

  // Error scenarios
  unauthorizedError: () => createMockErrorResponse(401, 'Invalid API key'),
  notFoundError: () => createMockErrorResponse(404, 'Resource not found'),
  validationError: () =>
    createMockErrorResponse(400, 'Validation failed', {
      field: 'vector',
      violations: ['must be array'],
    }),
  rateLimitError: () =>
    createMockErrorResponse(429, 'Rate limit exceeded', {
      retryAfter: 60,
    }),
  serverError: () => createMockErrorResponse(500, 'Internal server error'),
  serviceUnavailable: () =>
    createMockErrorResponse(503, 'Service temporarily unavailable'),

  // Network errors
  networkError: () => Promise.reject(new Error('Network request failed')),
  timeoutError: () => Promise.reject(new Error('Request timeout')),
};

// Setup global mock fetch for tests
export function setupMockFetch() {
  const mockFetch = new MockFetch();
  global.fetch = mockFetch.fetch.bind(mockFetch) as typeof globalThis.fetch;
  return mockFetch;
}

export default {
  createMockResponse,
  createMockErrorResponse,
  MockFetch,
  mockScenarios,
  setupMockFetch,
};
