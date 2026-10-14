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
  process.env.AETHERFY_WORKSPACE_ID = TEST_WORKSPACE_ID;
});

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
