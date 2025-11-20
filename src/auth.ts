/**
 * Manages API key authentication for Aetherfy Vectors.
 * Supports both Node.js and browser environments with appropriate security warnings.
 */

/**
 * Check if running in browser environment
 */
function isBrowser(): boolean {
  return (
    typeof window !== 'undefined' && typeof window.document !== 'undefined'
  );
}

/**
 * Check if running in Node.js environment
 */
function isNode(): boolean {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

/**
 * Custom error for authentication issues
 */
export class AuthenticationError extends Error {
  constructor(message: string = 'Invalid or missing API key') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/**
 * Manages API key authentication for Aetherfy Vectors
 */
export class APIKeyManager {
  private static readonly API_KEY_PREFIX = 'afy_';
  private static readonly API_KEY_PATTERN =
    /^afy_(live|test)_[a-zA-Z0-9]{16,}$/;

  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.validateApiKey();
    this.warnIfBrowser();
  }

  /**
   * Resolve API key from multiple sources with defined precedence:
   * 1. Explicit key parameter
   * 2. process.env.AETHERFY_API_KEY (Node.js only)
   * 3. process.env.AETHERFY_VECTORS_API_KEY (Node.js only)
   * 4. Throw AuthenticationError if none found
   */
  static resolveApiKey(explicitKey?: string): string {
    // 1. Use explicit key if provided
    if (explicitKey) {
      return explicitKey;
    }

    // Only try environment variables in Node.js
    if (isNode() && typeof process !== 'undefined' && process.env) {
      // 2. Try AETHERFY_API_KEY
      if (process.env.AETHERFY_API_KEY) {
        return process.env.AETHERFY_API_KEY;
      }

      // 3. Try AETHERFY_VECTORS_API_KEY
      if (process.env.AETHERFY_VECTORS_API_KEY) {
        return process.env.AETHERFY_VECTORS_API_KEY;
      }
    }

    // 4. Throw error if no API key found
    throw new AuthenticationError(
      'API key not found. Provide apiKey in constructor or set AETHERFY_API_KEY environment variable (Node.js only).'
    );
  }

  /**
   * Validate the API key format
   */
  private validateApiKey(): void {
    if (!this.apiKey) {
      throw new AuthenticationError('API key cannot be empty');
    }

    if (!this.apiKey.startsWith(APIKeyManager.API_KEY_PREFIX)) {
      throw new AuthenticationError(
        `Invalid API key format. API key must start with '${APIKeyManager.API_KEY_PREFIX}'`
      );
    }

    if (!APIKeyManager.API_KEY_PATTERN.test(this.apiKey)) {
      throw new AuthenticationError(
        'Invalid API key format. Expected format: afy_live_XXXXXXXXXXXXXXXX or afy_test_XXXXXXXXXXXXXXXX'
      );
    }
  }

  /**
   * Show security warning if running in browser
   */
  private warnIfBrowser(): void {
    if (isBrowser()) {
      console.warn(`
⚠️  SECURITY WARNING: Running Aetherfy Vectors in browser.
🔒 Never expose production API keys in browser code.
⚙️  CORS must be configured on the server.
✅ Use for: demos, admin tools, development only.
🔐 For production: Use a backend proxy.
      `);
    }
  }

  /**
   * Get authentication headers for API requests
   */
  getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /**
   * Get the raw API key (use with caution)
   */
  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * Check if the API key is a test key
   */
  isTestKey(): boolean {
    return this.apiKey.includes('_test_');
  }

  /**
   * Check if the API key is a live/production key
   */
  isLiveKey(): boolean {
    return this.apiKey.includes('_live_');
  }
}
