/**
 * Unit tests for APIKeyManager and authentication
 */

import { APIKeyManager, AuthenticationError } from '../../src/auth';

// Mock console.warn to test browser warnings
const originalWarn = console.warn;
let mockWarn: jest.Mock;

describe('APIKeyManager', () => {
  beforeEach(() => {
    mockWarn = jest.fn();
    console.warn = mockWarn;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  describe('API Key Validation', () => {
    it('should accept valid live API key', () => {
      expect(() => {
        new APIKeyManager('afy_live_1234567890123456');
      }).not.toThrow();
    });

    it('should accept valid test API key', () => {
      expect(() => {
        new APIKeyManager('afy_test_abcdefghijklmnop');
      }).not.toThrow();
    });

    it('should reject invalid prefix', () => {
      expect(() => {
        new APIKeyManager('invalid_prefix_1234567890123456');
      }).toThrow(AuthenticationError);
    });

    it('should reject empty API key', () => {
      expect(() => {
        new APIKeyManager('');
      }).toThrow(AuthenticationError);
    });

    it('should reject malformed API key', () => {
      expect(() => {
        new APIKeyManager('afy_invalid_format');
      }).toThrow(AuthenticationError);
    });
  });

  describe('API Key Resolution', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should use explicit API key first', () => {
      process.env.AETHERFY_API_KEY = 'afy_test_env_key_123456789';
      const apiKey = APIKeyManager.resolveApiKey('afy_test_explicit_key_12345');
      expect(apiKey).toBe('afy_test_explicit_key_12345');
    });

    it('should use AETHERFY_API_KEY env var', () => {
      process.env.AETHERFY_API_KEY = 'afy_test_env_key_123456789';
      const apiKey = APIKeyManager.resolveApiKey();
      expect(apiKey).toBe('afy_test_env_key_123456789');
    });

    it('should use AETHERFY_VECTORS_API_KEY as fallback', () => {
      delete process.env.AETHERFY_API_KEY;
      process.env.AETHERFY_VECTORS_API_KEY = 'afy_test_fallback_key_123';
      const apiKey = APIKeyManager.resolveApiKey();
      expect(apiKey).toBe('afy_test_fallback_key_123');
    });

    it('should throw error when no API key found', () => {
      delete process.env.AETHERFY_API_KEY;
      delete process.env.AETHERFY_VECTORS_API_KEY;

      expect(() => {
        APIKeyManager.resolveApiKey();
      }).toThrow(AuthenticationError);
    });
  });

  describe('Browser Warning', () => {
    const originalWindow = global.window;

    afterEach(() => {
      global.window = originalWindow;
    });

    it('should show warning in browser environment', () => {
      // Mock browser environment
      (global as Record<string, unknown>).window = { document: {} };

      new APIKeyManager('afy_test_1234567890123456');

      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('SECURITY WARNING')
      );
    });

    it('should not show warning in Node.js environment', () => {
      // Ensure we're in Node.js environment
      delete (global as Record<string, unknown>).window;

      new APIKeyManager('afy_test_1234567890123456');

      expect(mockWarn).not.toHaveBeenCalled();
    });
  });

  describe('Authentication Headers', () => {
    it('should generate correct auth headers', () => {
      const apiKey = 'afy_test_1234567890123456';
      const manager = new APIKeyManager(apiKey);

      const headers = manager.getAuthHeaders();

      expect(headers).toEqual({
        Authorization: `Bearer ${apiKey}`,
      });
    });
  });

  describe('Key Type Detection', () => {
    it('should detect test key', () => {
      const manager = new APIKeyManager('afy_test_1234567890123456');
      expect(manager.isTestKey()).toBe(true);
      expect(manager.isLiveKey()).toBe(false);
    });

    it('should detect live key', () => {
      const manager = new APIKeyManager('afy_live_1234567890123456');
      expect(manager.isLiveKey()).toBe(true);
      expect(manager.isTestKey()).toBe(false);
    });
  });

  describe('API Key Retrieval', () => {
    it('should return API key safely', () => {
      const apiKey = 'afy_test_1234567890123456';
      const manager = new APIKeyManager(apiKey);
      expect(manager.getApiKey()).toBe(apiKey);
    });
  });
});
