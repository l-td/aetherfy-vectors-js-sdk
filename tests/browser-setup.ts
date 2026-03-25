/**
 * Browser test environment setup
 */

// axios mock is configured globally in tests/setup.ts

// Mock browser location — jsdom 25+ (jest-environment-jsdom 30) provides a real
// Location object that cannot be redefined, so assign individual properties.
if (typeof window !== 'undefined' && window.location) {
  Object.assign(window.location, {
    hostname: 'localhost',
    href: 'http://localhost',
    protocol: 'http:',
    host: 'localhost',
  });
}

// Ensure process is available in browser test environment for compatibility
if (typeof (globalThis as Record<string, unknown>).process === 'undefined') {
  (globalThis as Record<string, unknown>).process = {
    env: {},
    versions: {},
    platform: 'browser',
  };
}

// Console warning handling is managed globally in tests/setup.ts
