/**
 * Node.js test environment setup
 * Configures nock for HTTP mocking in Node.js tests
 */

import nock from 'nock';

// Configure nock for testing
nock.disableNetConnect(); // Disable all real HTTP requests
nock.enableNetConnect('127.0.0.1'); // Allow localhost for local testing if needed

// Global test setup
beforeEach(() => {
  // Clean all nock interceptors before each test
  nock.cleanAll();
});

afterEach(() => {
  // Verify that all nock interceptors were used
  if (!nock.isDone()) {
    console.error('Pending nock interceptors:', nock.pendingMocks());
  }
  nock.cleanAll();
});

// Restore HTTP connections after all tests
afterAll(async () => {
  nock.restore();
  nock.enableNetConnect();

  // Give time for any pending async operations to complete
  await new Promise(resolve => setTimeout(resolve, 100));
});

export {};
