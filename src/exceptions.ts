/**
 * Custom error classes for Aetherfy Vectors SDK
 * All errors support instanceof checking and provide detailed error information
 */

/**
 * Base error class for all Aetherfy Vectors SDK errors
 */
export class AetherfyVectorsError extends Error {
  /**
   * Machine-readable error code from the backend's canonical envelope
   * (`body.error.code`). Examples: `COLLECTION_NOT_FOUND`,
   * `STORAGE_LIMIT_EXCEEDED`, `COLLECTION_IN_USE`. Symmetric with the
   * Python SDK's `exc.error_code` — clients can `if (err.code === 'X')`
   * without reaching into `err.details`.
   *
   * Set once by `createErrorFromResponse`; not declared readonly so the
   * factory can assign it after picking the concrete subclass without
   * having to thread `code` through every subclass constructor.
   */
  public code?: string;
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
      code: this.code,
      requestId: this.requestId,
      statusCode: this.statusCode,
      details: this.details,
    };
  }
}

/**
 * The API key is missing, wrong or revoked (HTTP 401). A 403 is never this
 * error: there the key is fine and the request is not allowed
 * (`PermissionDeniedError`).
 */
export class AuthenticationError extends AetherfyVectorsError {
  constructor(message: string = 'Invalid or missing API key') {
    super(message);
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/**
 * The key is valid, and this request is not allowed (HTTP 403).
 *
 * Thrown for any 403 whose `code` the SDK has no more specific class for;
 * `code` and `details` carry what the server said. The specific classes below
 * all extend it, so one `instanceof PermissionDeniedError` handles every
 * refusal of a valid key. `QuotaExceededError` is not one of them: the key may
 * do this, the account is at its cap.
 */
export class PermissionDeniedError extends AetherfyVectorsError {
  constructor(
    message: string = 'This request is not allowed',
    requestId?: string,
    details?: Record<string, unknown>
  ) {
    super(message, requestId, 403, details);
    this.name = 'PermissionDeniedError';
    Object.setPrototypeOf(this, PermissionDeniedError.prototype);
  }
}

/**
 * An agent's key holds a lower access level in the workspace than the request
 * needs (403 AGENT_ACCESS_LEVEL_INSUFFICIENT). `level` is the level the key
 * holds and `requiredLevel` the level the request needed, each `read`,
 * `read_write` or `full`; `workspace` names the workspace, or is null when it
 * was addressed by id. Not retryable: the account owner raises the level.
 */
export class AccessLevelInsufficientError extends PermissionDeniedError {
  public readonly workspace: string | null;
  public readonly level: string | null;
  public readonly requiredLevel: string | null;

  constructor(
    message: string,
    fields: {
      workspace: string | null;
      level: string | null;
      requiredLevel: string | null;
    },
    requestId?: string,
    details?: Record<string, unknown>
  ) {
    super(message, requestId, details);
    this.name = 'AccessLevelInsufficientError';
    this.workspace = fields.workspace;
    this.level = fields.level;
    this.requiredLevel = fields.requiredLevel;
    Object.setPrototypeOf(this, AccessLevelInsufficientError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      workspace: this.workspace,
      level: this.level,
      requiredLevel: this.requiredLevel,
    };
  }
}

/**
 * An agent's key tried to remove data from a protected collection (403
 * COLLECTION_PROTECTED), which no agent key may do whatever its access level.
 * `collectionName` names the collection.
 */
export class CollectionProtectedError extends PermissionDeniedError {
  public readonly collectionName: string | null;

  constructor(
    message: string,
    collectionName: string | null,
    requestId?: string,
    details?: Record<string, unknown>
  ) {
    super(message, requestId, details);
    this.name = 'CollectionProtectedError';
    this.collectionName = collectionName;
    Object.setPrototypeOf(this, CollectionProtectedError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      collectionName: this.collectionName,
    };
  }
}

/**
 * An agent's key called something only an account key may call (403
 * AUTH_AGENT_KEY_OUT_OF_SCOPE): the account-level routes, or renaming a
 * collection. `agentId` is the agent whose key it was and `requiredScope` the
 * scope the call needs, or null where it needs an account key.
 */
export class AgentKeyOutOfScopeError extends PermissionDeniedError {
  public readonly agentId: string | null;
  public readonly requiredScope: string | null;

  constructor(
    message: string,
    fields: { agentId: string | null; requiredScope: string | null },
    requestId?: string,
    details?: Record<string, unknown>
  ) {
    super(message, requestId, details);
    this.name = 'AgentKeyOutOfScopeError';
    this.agentId = fields.agentId;
    this.requiredScope = fields.requiredScope;
    Object.setPrototypeOf(this, AgentKeyOutOfScopeError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      agentId: this.agentId,
      requiredScope: this.requiredScope,
    };
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
 * Service unavailable errors (503, 502, 504).
 *
 * `retryAfter` is the number of seconds the server asked to wait (its
 * `Retry-After` header), or undefined when it sent none or an unreadable one.
 * The SDK's own retry waits it when it is within the cap (30 s) and the
 * call's deadline; a longer ask is never cut short: the error is thrown with
 * `retryAfter` for the caller to decide.
 */
export class ServiceUnavailableError extends AetherfyVectorsError {
  public readonly retryAfter?: number;

  constructor(
    message: string = 'Service temporarily unavailable',
    retryAfter?: number
  ) {
    super(message);
    this.name = 'ServiceUnavailableError';
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, ServiceUnavailableError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      retryAfter: this.retryAfter,
    };
  }
}

/** What an error keeps of the answer it was built from. */
export interface ErrorMeta {
  requestId?: string;
  statusCode?: number;
  details?: Record<string, unknown>;
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
    violations?: string[],
    meta: ErrorMeta = {}
  ) {
    super(message, meta.requestId, meta.statusCode, meta.details);
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
 * The request carries a member the API does not take (400
 * INVALID_REQUEST_FIELD): an unknown top-level member of a request body, or
 * one the endpoint does not support. `field` is the member's path in the
 * body, `key` the member itself and `suggestion` the nearest valid member, or
 * undefined when nothing is close.
 */
export class InvalidRequestFieldError extends ValidationError {
  public readonly key?: string;
  public readonly suggestion?: string;

  constructor(
    message: string,
    fields: { field?: string; key?: string; suggestion?: string } = {},
    meta: ErrorMeta = {}
  ) {
    super(message, fields.field, undefined, meta);
    this.name = 'InvalidRequestFieldError';
    this.key = fields.key;
    this.suggestion = fields.suggestion;
    Object.setPrototypeOf(this, InvalidRequestFieldError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      key: this.key,
      suggestion: this.suggestion,
    };
  }
}

/**
 * A filter carries a key the API does not know (400 INVALID_FILTER). `field`
 * is the key's JSON path (`filter.must[0].mach`), `key` the unknown key and
 * `suggestion` the nearest valid key, or undefined when nothing is close. The
 * sibling of `InvalidRequestFieldError`, which is the same answer for a member
 * of the request body outside any filter.
 */
export class InvalidFilterError extends ValidationError {
  public readonly key?: string;
  public readonly suggestion?: string;

  constructor(
    message: string,
    fields: { field?: string; key?: string; suggestion?: string } = {},
    meta: ErrorMeta = {}
  ) {
    super(message, fields.field, undefined, meta);
    this.name = 'InvalidFilterError';
    this.key = fields.key;
    this.suggestion = fields.suggestion;
    Object.setPrototypeOf(this, InvalidFilterError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      key: this.key,
      suggestion: this.suggestion,
    };
  }
}

/**
 * Something the request named does not exist (HTTP 404). The parent of every
 * not-found error (collection, point, schema, workspace), and what a 404
 * whose `code` this SDK does not know arrives as, with that code. Catch it to
 * handle any of them.
 */
export class NotFoundError extends AetherfyVectorsError {
  constructor(
    message: string,
    requestId?: string,
    statusCode: number = 404,
    details?: Record<string, unknown>
  ) {
    super(message, requestId, statusCode, details);
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * Collection not found errors (404)
 */
export class CollectionNotFoundError extends NotFoundError {
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
export class PointNotFoundError extends NotFoundError {
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
  /**
   * `false` when the connection was never made (DNS, refused, a connect that
   * never completed): the request never left, so any operation may be
   * retried (retry-policy.ts). Undefined when it may have been sent.
   */
  public readonly requestSent?: false;

  constructor(
    message: string = 'Network error occurred',
    cause?: Error,
    requestSent?: false
  ) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
    this.requestSent = requestSent;
    Object.setPrototypeOf(this, NetworkError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      cause: this.cause?.message,
      requestSent: this.requestSent,
    };
  }
}

/**
 * A 409 with no more specific class. `COLLECTION_IN_USE` and
 * `COLLECTION_EXISTS_IN_OTHER_REGION` keep their own classes; every other 409
 * lands here, with the backend's code in `code`.
 *
 * There is deliberately no field naming the conflicting resource: an earlier
 * `conflictingResource` read a top-level key the API never sends, so it was
 * `undefined` on every error. Removed 2026-09-24 rather than left promising.
 */
export class ConflictError extends AetherfyVectorsError {
  constructor(
    message: string = 'Resource conflict',
    statusCode?: number,
    details?: Record<string, unknown>
  ) {
    super(message, undefined, statusCode, details);
    this.name = 'ConflictError';
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

/**
 * Raised when a collection name is created in one region but already
 * exists in a different region. Carries the rejection's typed fields
 * so callers can offer a different name or pin to the existing region
 * without parsing error message strings.
 */
export class CollectionInOtherRegionError extends AetherfyVectorsError {
  public readonly collectionName: string;
  public readonly existingRegions: string[];
  public readonly requestingRegion: string;

  constructor(
    collectionName: string,
    existingRegions: string[],
    requestingRegion: string,
    message?: string
  ) {
    super(
      message ||
        `Collection '${collectionName}' already exists in region ${existingRegions.join(', ')}. ` +
          `Collection names are unique per workspace; pick a different name or use the existing one.`,
      undefined,
      409,
      {
        collection_name: collectionName,
        existing_regions: existingRegions,
        requesting_region: requestingRegion,
      }
    );
    this.name = 'CollectionInOtherRegionError';
    this.collectionName = collectionName;
    this.existingRegions = existingRegions;
    this.requestingRegion = requestingRegion;
    Object.setPrototypeOf(this, CollectionInOtherRegionError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      collectionName: this.collectionName,
      existingRegions: this.existingRegions,
      requestingRegion: this.requestingRegion,
    };
  }
}

/**
 * An agent's API key addressed a workspace it has not been granted (403
 * AGENT_KEY_WORKSPACE_FORBIDDEN). The key Aetherfy injects into a deployed
 * agent reaches its own workspace plus the workspaces the account owner
 * granted it; any other is refused whether or not it exists. `workspace`
 * names it, or is null when it was addressed by id. Not retryable: the owner
 * grants access on the agent's page in the dashboard, or with
 * `afy access <agent> --add <workspace>`, and it takes effect within 60
 * seconds.
 */
export class AgentWorkspaceForbiddenError extends PermissionDeniedError {
  public readonly workspace: string | null;

  constructor(
    workspace: string | null,
    message?: string,
    requestId?: string,
    details?: Record<string, unknown>
  ) {
    const where = workspace ? `workspace '${workspace}'` : 'this workspace';
    const add = workspace ? workspace : '<workspace>';
    super(
      (message || `This agent's API key cannot use ${where}.`) +
        ` Ask the account owner to grant this agent access to ${where}: ` +
        `the agent's page in the dashboard, or \`afy access <agent> --add ${add}\`.`,
      requestId,
      details ?? { workspace }
    );
    this.name = 'AgentWorkspaceForbiddenError';
    this.workspace = workspace;
    Object.setPrototypeOf(this, AgentWorkspaceForbiddenError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      workspace: this.workspace,
    };
  }
}

/**
 * No such workspace in this account (404 WORKSPACE_NOT_FOUND). `workspace` is
 * the name as sent, or null when it was addressed by id; `workspaceId` is then
 * the id as sent. Not retryable: create the workspace, or fix the name. A
 * workspace of another account answers the same way, by design.
 */
export class WorkspaceNotFoundError extends NotFoundError {
  public readonly workspace: string | null;
  public readonly workspaceId: string | null;

  constructor(
    workspace: string | null,
    workspaceId: string | null = null,
    message?: string
  ) {
    const where = workspace
      ? `Workspace '${workspace}'`
      : `Workspace id '${workspaceId}'`;
    super(message || `${where} not found in this account.`, undefined, 404, {
      workspace,
      workspace_id: workspaceId,
    });
    this.name = 'WorkspaceNotFoundError';
    this.workspace = workspace;
    this.workspaceId = workspaceId;
    Object.setPrototypeOf(this, WorkspaceNotFoundError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      workspace: this.workspace,
      workspaceId: this.workspaceId,
    };
  }
}

/**
 * A plan limit or the storage quota is reached: 403 PLAN_LIMIT_EXCEEDED or
 * 429 STORAGE_LIMIT_EXCEEDED. Not a `PermissionDeniedError`: the key may do
 * this, the account is at its cap.
 *
 * - `limit`: the limit's name as the server sends it (`max_collections`), or
 *   undefined for the storage quota, which is told apart by its `code`
 *   (`STORAGE_LIMIT_EXCEEDED`).
 * - `allowed`: the plan's number, `false` for a feature the plan does not
 *   include, `null` where the plan has no cap (undefined only if the server
 *   sent none).
 * - `current`: the usage now, or undefined for a yes/no feature (the server
 *   sends none).
 * - `upgradeUrl`: where to raise the cap, or undefined.
 */
export class QuotaExceededError extends AetherfyVectorsError {
  public readonly current?: number;
  public readonly limit?: string;
  public readonly allowed?: number | false | null;
  public readonly upgradeUrl?: string;

  constructor(
    message: string,
    fields: {
      current?: number;
      limit?: string;
      allowed?: number | false | null;
      upgradeUrl?: string;
    } = {},
    requestId?: string,
    statusCode?: number,
    details?: Record<string, unknown>
  ) {
    super(message, requestId, statusCode, details);
    this.name = 'QuotaExceededError';
    this.current = fields.current;
    this.limit = fields.limit;
    this.allowed = fields.allowed;
    this.upgradeUrl = fields.upgradeUrl;
    Object.setPrototypeOf(this, QuotaExceededError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      current: this.current,
      limit: this.limit,
      allowed: this.allowed,
      upgradeUrl: this.upgradeUrl,
    };
  }
}

/**
 * Collection in use errors (409) - when trying to delete a collection still referenced by agents
 */
export class CollectionInUseError extends AetherfyVectorsError {
  public readonly collectionName: string;
  public readonly agents: string[];

  constructor(collectionName: string, agents: string[]) {
    const agentList = agents.join(', ');
    super(`Collection '${collectionName}' is in use by agent(s): ${agentList}`);
    this.name = 'CollectionInUseError';
    this.collectionName = collectionName;
    this.agents = agents;
    Object.setPrototypeOf(this, CollectionInUseError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      collectionName: this.collectionName,
      agents: this.agents,
    };
  }
}

/**
 * Schema not found errors - when no schema is defined for a collection
 */
export class SchemaNotFoundError extends NotFoundError {
  public readonly collectionName: string;

  constructor(collectionName: string) {
    super(`No schema defined for collection '${collectionName}'`);
    this.name = 'SchemaNotFoundError';
    this.collectionName = collectionName;
    Object.setPrototypeOf(this, SchemaNotFoundError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      collectionName: this.collectionName,
    };
  }
}

/**
 * Schema validation errors - when payload fails schema validation
 */
export class SchemaValidationError extends AetherfyVectorsError {
  public readonly errors: Array<{
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
    errors: Array<{
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
    const messages = errors.flatMap(ve =>
      ve.errors.map(e => `Vector ${ve.index}: ${e.message}`)
    );
    super(`Schema validation failed:\n${messages.join('\n')}`);
    this.name = 'SchemaValidationError';
    this.errors = errors;
    Object.setPrototypeOf(this, SchemaValidationError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      errors: this.errors,
    };
  }
}

/**
 * Raised when a multi-chunk upsert succeeded for some chunks and failed
 * for others. Carries which point IDs were saved and which weren't so
 * callers can retry the failed ones surgically without double-upserting
 * the saved ones (Qdrant upsert is idempotent by point ID, so a retry
 * of an already-saved point is also safe — this just avoids the wasted
 * round-trip).
 *
 * Thrown only when the SDK had to split the upsert into multiple HTTP
 * requests due to byte-size limits and at least one of those requests
 * failed after the SDK's retry budget was exhausted. Single-request
 * upserts that fail throw the more specific error directly (Validation,
 * Network, ServiceUnavailable, etc.) — same behaviour as before chunking.
 */
export class PartialUpsertError extends AetherfyVectorsError {
  public readonly saved: number;
  public readonly total: number;
  public readonly failed: Array<{
    pointIds: Array<string | number>;
    error: AetherfyVectorsError;
  }>;

  constructor(
    saved: number,
    total: number,
    failed: Array<{
      pointIds: Array<string | number>;
      error: AetherfyVectorsError;
    }>
  ) {
    const failedCount = failed.reduce((n, f) => n + f.pointIds.length, 0);
    // A failed chunk's outcome is unknown, never "not written": a chunk that
    // timed out or lost its connection may have been applied, and the server
    // writes a large chunk in parts, so a refusal can come after part of it
    // was written.
    super(
      `Partial upsert: ${saved} of ${total} points confirmed saved; the outcome of the other ` +
        `${failedCount} point(s), in ${failed.length} chunk(s) that failed, is unknown: a chunk ` +
        `that timed out, lost its connection or was refused may have been written in whole or ` +
        `in part. Retrying the upsert is safe: it replaces points by id. See .failed for ` +
        `per-chunk point IDs and errors.`
    );
    this.name = 'PartialUpsertError';
    this.saved = saved;
    this.total = total;
    this.failed = failed;
    Object.setPrototypeOf(this, PartialUpsertError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      saved: this.saved,
      total: this.total,
      failed: this.failed.map(f => ({
        pointIds: f.pointIds,
        error: f.error.toJSON(),
      })),
    };
  }
}

/** A string field of an error body, or undefined when absent or not a string. */
function textOf(
  body: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** A number the server counted with, or undefined. */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Utility function to create appropriate error from HTTP response.
 *
 * `retryAfter` is the seconds the response's `Retry-After` header asked to
 * wait (already read by the HTTP layer); a 429 and a 502/503/504 carry it.
 */
export function createErrorFromResponse(
  responseData: Record<string, unknown>,
  status: number,
  statusText: string,
  requestId?: string,
  retryAfter?: number
): AetherfyVectorsError {
  // Canonical vectordb error envelope:
  //   { "error": { "code", "message", ...extras } }
  // The JS SDK only talks to vectordb (Node/Express); it does not
  // parse FastAPI's `detail` key. Per docs/REVIEW_FAQ.md section 56,
  // each consumer reads only from the surface(s) it talks to so its
  // parser stays simple and asserts the contract.
  const nestedError =
    responseData?.error !== null && typeof responseData?.error === 'object'
      ? (responseData.error as Record<string, unknown>)
      : undefined;
  const errorCode = nestedError?.code as string | undefined;
  // Stamp `code` on every error we build so clients can switch on
  // `err.code === 'X'` symmetrically with the Python SDK, regardless of
  // which concrete subclass we picked below.
  const stamp = (err: AetherfyVectorsError): AetherfyVectorsError => {
    err.code = errorCode;
    return err;
  };

  let message: string;
  try {
    const rawMessage =
      nestedError?.message ||
      responseData?.message ||
      (typeof responseData?.error === 'string'
        ? responseData.error
        : undefined) ||
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
    case 400: {
      if (errorCode === 'INVALID_FILTER') {
        return stamp(
          new InvalidFilterError(
            message,
            {
              field: textOf(nestedError, 'field'),
              key: textOf(nestedError, 'key'),
              suggestion: textOf(nestedError, 'suggestion'),
            },
            { requestId, statusCode: status, details: nestedError }
          )
        );
      }
      if (errorCode === 'INVALID_REQUEST_FIELD') {
        return stamp(
          new InvalidRequestFieldError(
            message,
            {
              field: textOf(nestedError, 'field'),
              key: textOf(nestedError, 'key'),
              suggestion: textOf(nestedError, 'suggestion'),
            },
            { requestId, statusCode: status, details: nestedError }
          )
        );
      }
      return stamp(
        new ValidationError(
          message,
          nestedError?.field as string | undefined,
          nestedError?.violations as string[] | undefined
        )
      );
    }

    case 403: {
      // By code first, then by status: a 403 is "the key is valid and this is
      // not allowed", never "the key is wrong" (that is the 401 below).
      if (errorCode === 'PLAN_LIMIT_EXCEEDED') {
        // `limit` NAMES the limit (`max_collections`), `allowed` is the plan's
        // number (false: the plan lacks the feature; null: no cap) and
        // `current` the usage now (absent for a yes/no feature).
        const axis = textOf(nestedError, 'limit');
        const allowed = nestedError?.allowed;
        return stamp(
          new QuotaExceededError(
            message,
            {
              current: countOf(nestedError?.current),
              limit: axis,
              allowed:
                countOf(allowed) ??
                (allowed === false || allowed === null ? allowed : undefined),
              upgradeUrl: textOf(nestedError, 'upgrade_url'),
            },
            requestId,
            status,
            nestedError
          )
        );
      }
      if (errorCode === 'AGENT_KEY_WORKSPACE_FORBIDDEN') {
        return stamp(
          new AgentWorkspaceForbiddenError(
            textOf(nestedError, 'workspace') ?? null,
            undefined,
            requestId,
            nestedError
          )
        );
      }
      if (errorCode === 'AGENT_ACCESS_LEVEL_INSUFFICIENT') {
        return stamp(
          new AccessLevelInsufficientError(
            message,
            {
              workspace: textOf(nestedError, 'workspace') ?? null,
              level: textOf(nestedError, 'level') ?? null,
              requiredLevel: textOf(nestedError, 'required_level') ?? null,
            },
            requestId,
            nestedError
          )
        );
      }
      if (errorCode === 'COLLECTION_PROTECTED') {
        return stamp(
          new CollectionProtectedError(
            message,
            textOf(nestedError, 'collection_name') ?? null,
            requestId,
            nestedError
          )
        );
      }
      if (errorCode === 'AUTH_AGENT_KEY_OUT_OF_SCOPE') {
        return stamp(
          new AgentKeyOutOfScopeError(
            message,
            {
              agentId: textOf(nestedError, 'agent_id') ?? null,
              requiredScope: textOf(nestedError, 'required_scope') ?? null,
            },
            requestId,
            nestedError
          )
        );
      }
      return stamp(new PermissionDeniedError(message, requestId, nestedError));
    }

    case 401:
      return stamp(new AuthenticationError(message));

    case 404: {
      const str = (key: string): string | null =>
        typeof nestedError?.[key] === 'string'
          ? (nestedError[key] as string)
          : null;
      if (errorCode === 'COLLECTION_NOT_FOUND') {
        return stamp(
          new CollectionNotFoundError(str('collection_name') ?? 'unknown')
        );
      }
      if (errorCode === 'POINT_NOT_FOUND') {
        return stamp(
          new PointNotFoundError(
            str('point_id') ?? 'unknown',
            str('collection_name') ?? 'unknown'
          )
        );
      }
      if (errorCode === 'WORKSPACE_NOT_FOUND') {
        return stamp(
          new WorkspaceNotFoundError(
            str('workspace'),
            str('workspace_id'),
            message
          )
        );
      }
      if (errorCode === 'SCHEMA_NOT_DEFINED') {
        return stamp(
          new SchemaNotFoundError(str('collection_name') ?? 'unknown')
        );
      }
      // A 404 whose code this SDK does not know: still a typed not-found.
      return stamp(
        new NotFoundError(
          message,
          requestId,
          status,
          details as Record<string, unknown> | undefined
        )
      );
    }

    case 422:
      // Unprocessable: VALIDATION_ERROR, COLLECTION_SDK_MANAGED, ...
      return stamp(
        new ValidationError(
          message,
          nestedError?.field as string | undefined,
          nestedError?.violations as string[] | undefined
        )
      );

    case 409: {
      const errorObj = responseData?.error as
        | Record<string, unknown>
        | undefined;
      if (errorObj?.code === 'COLLECTION_IN_USE') {
        return stamp(
          new CollectionInUseError(
            String(errorObj.collection_name || 'unknown'),
            (errorObj.agents as string[]) || []
          )
        );
      }
      if (errorObj?.code === 'COLLECTION_EXISTS_IN_OTHER_REGION') {
        return stamp(
          new CollectionInOtherRegionError(
            String(errorObj.collection_name || 'unknown'),
            Array.isArray(errorObj.existing_regions)
              ? (errorObj.existing_regions as string[])
              : [],
            String(errorObj.requesting_region || ''),
            typeof errorObj.message === 'string' ? errorObj.message : undefined
          )
        );
      }
      return stamp(
        new ConflictError(
          message,
          409,
          details as Record<string, unknown> | undefined
        )
      );
    }

    case 429:
      if (errorCode === 'STORAGE_LIMIT_EXCEEDED') {
        // The numbers are nested: error.details.{current_bytes, limit_bytes}.
        const bytes =
          nestedError?.details !== null &&
          typeof nestedError?.details === 'object'
            ? (nestedError.details as Record<string, unknown>)
            : undefined;
        return stamp(
          new QuotaExceededError(
            message,
            {
              current: countOf(bytes?.current_bytes),
              allowed: countOf(bytes?.limit_bytes),
            },
            requestId,
            status,
            nestedError
          )
        );
      }
      // The time the server asked for: the header (read by the HTTP layer),
      // else the body's own field.
      return stamp(
        new RateLimitExceededError(
          message,
          retryAfter ?? countOf(responseData?.retryAfter)
        )
      );

    case 502:
    case 503:
    case 504:
      return stamp(new ServiceUnavailableError(message, retryAfter));

    default:
      return stamp(
        new AetherfyVectorsError(
          message,
          requestId,
          status,
          details as Record<string, unknown> | undefined
        )
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
