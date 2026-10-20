/**
 * Jest test setup file
 * Shared test configuration and utilities for all test environments
 */

// The workspace id the control plane would inject into an agent. Every
// collection lives in a workspace, so a client built with the default
// workspace: 'auto' outside an agent is refused; the suite runs as if inside
// one. Tests of that refusal unset the variable themselves.
export const TEST_WORKSPACE_ID = '11111111-2222-4333-8444-555555555555';
beforeEach(() => {
  // The browser project runs without a `process` global.
  if (typeof process !== 'undefined') {
    process.env.AETHERFY_WORKSPACE_ID = TEST_WORKSPACE_ID;
  }
});

// The retry backoff waits 1 s, 2 s, 4 s; the suite does not. The backoff
// itself is pinned by retry-http-errors.test.ts through retryWithBackoff.
import { backoff } from '../src/retry-policy';
backoff.baseDelayMs = 1;

// Global test setup
beforeEach(() => {
  jest.clearAllMocks();
});

// Suppress console warnings in tests unless specifically testing them
const originalWarn = console.warn;
beforeEach(() => {
  console.warn = jest.fn();
});
afterEach(() => {
  console.warn = originalWarn;
});
