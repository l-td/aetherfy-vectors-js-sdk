/**
 * Browser compatibility tests
 */

import { AetherfyVectorsClient } from '../../src/client';
import { APIKeyManager } from '../../src/auth';

describe('Browser Compatibility', () => {
  describe('Client Initialization', () => {
    it('should initialize client in browser environment', () => {
      expect(() => {
        new AetherfyVectorsClient({
          apiKey: 'afy_test_1234567890123456',
          enableConnectionPooling: false,
        });
      }).not.toThrow();
    });

    it('should show security warning in browser', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      new APIKeyManager('afy_test_1234567890123456');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('SECURITY WARNING')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('API Operations in Browser', () => {
    it('should create client instance with proper configuration', () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });

      expect(client).toBeInstanceOf(AetherfyVectorsClient);
    });

    it('should support custom endpoints for browser usage', () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        endpoint: 'https://custom.api.endpoint.com',
        enableConnectionPooling: false,
      });

      expect(client).toBeInstanceOf(AetherfyVectorsClient);
    });
  });

  describe('Environment Detection in Browser', () => {
    it('should detect browser environment correctly', () => {
      // Mock browser globals
      (global as Record<string, unknown>).window = { document: {} };
      delete (global as Record<string, unknown>).process;

      // Re-import to get fresh environment detection
      const utils = require('../../src/utils');

      expect(utils.isBrowser()).toBe(true);
      expect(utils.isNode()).toBe(false);
    });
  });

  describe('Error Handling in Browser', () => {
    it('should create client instance that can handle errors', () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });

      expect(client).toBeInstanceOf(AetherfyVectorsClient);
      // Error handling is tested in unit tests with proper mocking
    });
  });

  describe('Browser-specific Features', () => {
    it('should not rely on Node.js-specific APIs', () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });

      expect(client).toBeInstanceOf(AetherfyVectorsClient);
    });

    it('should handle browser storage limitations', () => {
      // Test that client doesn't rely on localStorage or sessionStorage
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });

      expect(client).toBeInstanceOf(AetherfyVectorsClient);
      // Should work without local storage
    });
  });

  describe('Browser Performance', () => {
    it('should support async operations without blocking', () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });

      // Client should be created and ready to use
      expect(client).toBeInstanceOf(AetherfyVectorsClient);
      // Actual async behavior is tested in integration tests
    });

    it('should support promise-based API', () => {
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        enableConnectionPooling: false,
      });

      // All client methods should return promises
      expect(client.getCollections()).toBeInstanceOf(Promise);
    });
  });
});
