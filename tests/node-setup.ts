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

// Turn interception off when this file is done — in the TEST ENVIRONMENT's
// teardown (tests/node-environment.ts), NOT an afterAll. A file that fails to
// load runs no tests and so no afterAll, and its nock instance used to stay
// hooked into the worker's shared http module, refusing every later file's
// mocked requests ("Disallowed net connect"). Teardown runs for every file.
(
  globalThis as { __restoreNetworkInterception?: () => void }
).__restoreNetworkInterception = () => {
  nock.restore();
  nock.enableNetConnect();
};

export {};
