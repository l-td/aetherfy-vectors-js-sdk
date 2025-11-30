/**
 * Custom error classes for Aetherfy Vectors SDK
 * All errors support instanceof checking and provide detailed error information
 */

/**
 * Base error class for all Aetherfy Vectors SDK errors
 */
export class AetherfyVectorsError extends Error {
  public readonly requestId?: string;
  public readonly statusCode?: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    requestId?: string,
    statusCode?: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AetherfyVectorsError';
    this.requestId = requestId;
    this.statusCode = statusCode;
    this.details = details;

    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, AetherfyVectorsError.prototype);
  }

  /**
   * Get a JSON representation of the error
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      requestId: this.requestId,
      statusCode: this.statusCode,
      details: this.details,
    };
  }
}

/**
 * Authentication-related errors (401, 403)
 */
export class AuthenticationError extends AetherfyVectorsError {
  constructor(message: string = 'Invalid or missing API key') {
    super(message);
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/**
 * Rate limit exceeded errors (429)
 */
export class RateLimitExceededError extends AetherfyVectorsError {
  public readonly retryAfter?: number;

  constructor(message: string = 'Rate limit exceeded', retryAfter?: number) {
    super(message);
    this.name = 'RateLimitExceededError';
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, RateLimitExceededError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      retryAfter: this.retryAfter,
    };
  }
}

/**
 * Service unavailable errors (503, 502, 504)
 */
export class ServiceUnavailableError extends AetherfyVectorsError {
  constructor(message: string = 'Service temporarily unavailable') {
    super(message);
    this.name = 'ServiceUnavailableError';
    Object.setPrototypeOf(this, ServiceUnavailableError.prototype);
  }
}

/**
 * Request validation errors (400)
 */
export class ValidationError extends AetherfyVectorsError {
  public readonly field?: string;
  public readonly violations?: string[];

  constructor(
    message: string = 'Invalid request parameters',
    field?: string,
    violations?: string[]
  ) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.violations = violations;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      field: this.field,
      violations: this.violations,
    };
  }
}

/**
 * Collection not found errors (404)
 */
export class CollectionNotFoundError extends AetherfyVectorsError {
  public readonly collectionName: string;

  constructor(collectionName: string) {
    super(`Collection '${collectionName}' not found`);
    this.name = 'CollectionNotFoundError';
    this.collectionName = collectionName;
    Object.setPrototypeOf(this, CollectionNotFoundError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      collectionName: this.collectionName,
    };
  }
}

/**
 * Point not found errors (404)
 */
export class PointNotFoundError extends AetherfyVectorsError {
  public readonly pointId: string | number;
  public readonly collectionName: string;

  constructor(pointId: string | number, collectionName: string) {
    super(`Point '${pointId}' not found in collection '${collectionName}'`);
    this.name = 'PointNotFoundError';
    this.pointId = pointId;
    this.collectionName = collectionName;
    Object.setPrototypeOf(this, PointNotFoundError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      pointId: this.pointId,
      collectionName: this.collectionName,
    };
  }
}

/**
 * Request timeout errors
 */
export class RequestTimeoutError extends AetherfyVectorsError {
  public readonly timeoutMs: number;

  constructor(
    message: string = 'Request timed out',
    timeoutMs: number = 30000
  ) {
    super(message);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, RequestTimeoutError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      timeoutMs: this.timeoutMs,
    };
  }
}

/**
 * Network-related errors
 */
export class NetworkError extends AetherfyVectorsError {
  public readonly cause?: Error;

  constructor(message: string = 'Network error occurred', cause?: Error) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
    Object.setPrototypeOf(this, NetworkError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      cause: this.cause?.message,
    };
  }
}

/**
 * Conflict errors (409) - when trying to create something that already exists
 */
export class ConflictError extends AetherfyVectorsError {
  public readonly conflictingResource?: string;

  constructor(
    message: string = 'Resource conflict',
    conflictingResource?: string
  ) {
    super(message);
    this.name = 'ConflictError';
    this.conflictingResource = conflictingResource;
    Object.setPrototypeOf(this, ConflictError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      conflictingResource: this.conflictingResource,
    };
  }
}

/**
 * Quota exceeded errors
 */
export class QuotaExceededError extends AetherfyVectorsError {
  public readonly quotaType: string;
  public readonly current?: number;
  public readonly limit?: number;

  constructor(
    message: string,
    quotaType: string,
    current?: number,
    limit?: number
  ) {
    super(message);
    this.name = 'QuotaExceededError';
    this.quotaType = quotaType;
    this.current = current;
    this.limit = limit;
    Object.setPrototypeOf(this, QuotaExceededError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      quotaType: this.quotaType,
      current: this.current,
      limit: this.limit,
    };
  }
}

/**
 * Schema validation errors - when payload fails schema validation
 */
export class SchemaValidationError extends AetherfyVectorsError {
  public readonly validationErrors: Array<{
    index: number;
    id: string | number;
    errors: Array<{
      field: string;
      code: string;
      message: string;
      expected?: string;
      actual?: string;
    }>;
  }>;

  constructor(
    validationErrors: Array<{
      index: number;
      id: string | number;
      errors: Array<{
        field: string;
        code: string;
        message: string;
        expected?: string;
        actual?: string;
      }>;
    }>
  ) {
    // Create human-readable message
    const messages = validationErrors.flatMap(ve =>
      ve.errors.map(e => `Vector ${ve.index}: ${e.message}`)
    );
    super(`Schema validation failed:\n${messages.join('\n')}`);
    this.name = 'SchemaValidationError';
    this.validationErrors = validationErrors;
    Object.setPrototypeOf(this, SchemaValidationError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      validationErrors: this.validationErrors,
    };
  }
}

/**
 * Utility function to create appropriate error from HTTP response
 */
export function createErrorFromResponse(
  responseData: Record<string, unknown>,
  status: number,
  statusText: string,
  requestId?: string
): AetherfyVectorsError {
  let message: string;
  try {
    const rawMessage =
      responseData?.message ||
      responseData?.error ||
      statusText ||
      'Unknown error';
    if (typeof rawMessage === 'string') {
      message = rawMessage;
    } else if (rawMessage && typeof rawMessage === 'object') {
      message = JSON.stringify(rawMessage);
    } else {
      message = String(rawMessage);
    }
  } catch {
    message = statusText || 'Unknown error';
  }
  const details = responseData?.details;

  switch (status) {
    case 400:
      return new ValidationError(
        message,
        responseData?.field as string | undefined,
        responseData?.violations as string[] | undefined
      );

    case 401:
    case 403:
      return new AuthenticationError(message);

    case 404:
      // Check for both pointId and collectionName first (more specific case)
      if (responseData?.pointId && responseData?.collectionName) {
        return new PointNotFoundError(
          responseData.pointId as string | number,
          String(responseData.collectionName)
        );
      }
      // Then check for just collectionName
      if (responseData?.collectionName) {
        return new CollectionNotFoundError(String(responseData.collectionName));
      }
      return new AetherfyVectorsError(
        typeof message === 'string' ? message : 'Unknown error',
        requestId,
        status,
        details as Record<string, unknown> | undefined
      );

    case 409:
      return new ConflictError(
        message,
        responseData?.conflictingResource as string
      );

    case 429:
      return new RateLimitExceededError(
        message,
        responseData?.retryAfter as number
      );

    case 502:
    case 503:
    case 504:
      return new ServiceUnavailableError(message);

    default:
      return new AetherfyVectorsError(
        message,
        requestId,
        status,
        details as Record<string, unknown> | undefined
      );
  }
}

/**
 * Type guard to check if an error is an Aetherfy Vectors error
 */
export function isAetherfyVectorsError(
  error: unknown
): error is AetherfyVectorsError {
  return error instanceof AetherfyVectorsError;
}

/**
 * Type guard to check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  return (
    error instanceof ServiceUnavailableError ||
    error instanceof RequestTimeoutError ||
    error instanceof NetworkError ||
    (error instanceof RateLimitExceededError && error.retryAfter !== undefined)
  );
}
