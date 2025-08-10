/**
 * Jest test setup file
 * Global test configuration and utilities
 */

// Mock fetch for testing - must be done before any imports that use fetch
import fetchMock from 'jest-fetch-mock';

// Enable mocks first
fetchMock.enableMocks();

// Mock cross-fetch module to ensure it returns our mocked fetch
jest.mock('cross-fetch', () => {
  return fetchMock;
});

// Force override fetch on all possible globals to ensure mocks work
// Use a more aggressive approach to ensure fetch is always mocked in tests
(globalThis as Record<string, unknown>).fetch = fetchMock;
(global as Record<string, unknown>).fetch = fetchMock;

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).fetch = fetchMock;
}

// Also ensure fetch is available for dynamic imports
Object.defineProperty(globalThis, 'fetch', {
  value: fetchMock,
  writable: true,
  configurable: true,
  enumerable: true,
});

Object.defineProperty(global, 'fetch', {
  value: fetchMock,
  writable: true,
  configurable: true,
  enumerable: true,
});

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'fetch', {
    value: fetchMock,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

// Import AbortController polyfill to provide real instances in test environment
import 'abortcontroller-polyfill/dist/polyfill-patch-fetch';

// Global test setup
beforeEach(() => {
  // Clear all mocks before each test
  fetchMock.resetMocks();
  jest.clearAllMocks();
});

// Global test utilities
(global as Record<string, unknown>).mockApiResponse = (
  data: unknown,
  status: number = 200
) => {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({
      'content-type': 'application/json',
    }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response);
};

(global as Record<string, unknown>).mockApiError = (
  status: number,
  message: string
) => {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: 'Error',
    headers: new Headers({
      'content-type': 'application/json',
    }),
    json: () => Promise.resolve({ message }),
    text: () => Promise.resolve(JSON.stringify({ message })),
  } as Response);
};

// Suppress console warnings in tests unless specifically testing them
const originalWarn = console.warn;
beforeEach(() => {
  console.warn = jest.fn();
});
afterEach(() => {
  console.warn = originalWarn;
});

export {};
