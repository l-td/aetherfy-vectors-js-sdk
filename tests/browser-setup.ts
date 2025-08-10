/**
 * Browser test environment setup
 */

// fetchMock is already configured globally in tests/setup.ts
// No need for additional setup here

// Mock browser APIs
Object.defineProperty(window, 'location', {
  value: {
    hostname: 'localhost',
    href: 'http://localhost',
    protocol: 'http:',
    host: 'localhost',
  },
  writable: true,
});

// Ensure process is available in browser test environment for compatibility
if (typeof (globalThis as Record<string, unknown>).process === 'undefined') {
  (globalThis as Record<string, unknown>).process = {
    env: { NODE_ENV: 'test' },
    versions: {},
    platform: 'browser',
  };
}

// Console warning handling is managed globally in tests/setup.ts
