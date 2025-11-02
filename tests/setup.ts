/**
 * Jest test setup file
 * Shared test configuration and utilities for all test environments
 */

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

export {};
