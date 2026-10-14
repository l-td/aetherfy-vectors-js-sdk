/**
 * When a request is retried: one rule, the same in the Python SDK
 * (aetherfy_vectors/retry_policy.py).
 *
 * Three kinds of failure:
 *
 * 1. REFUSED BEFORE ANYTHING HAPPENED. Retried for EVERY operation.
 *    - 503 WORKSPACE_LOOKUP_UNAVAILABLE, COLLECTION_LOOKUP_UNAVAILABLE,
 *      PLACEMENT_UNAVAILABLE: the server refused at its edge; nothing ran.
 *    - A connection never made: DNS (ENOTFOUND, EAI_AGAIN), connection
 *      refused (ECONNREFUSED), connect timeout (ETIMEDOUT on `connect`).
 *    - 429 with a Retry-After: refused, nothing ran (as before this rule).
 * 2. AMBIGUOUS: a timeout waiting for the answer, a reset after sending, any
 *    other 5xx. The request may have run. Retried only for an operation whose
 *    repeat gives the same result (REPEATABLE below). A ONCE operation throws
 *    after one attempt: its repeat after a hidden success reports a false
 *    error (a delete finds nothing, a create finds the collection).
 * 3. Everything else (4xx) is never retried.
 *
 * Attempts and backoff: 3 retries after the first attempt, waiting about 1,
 * 2, then 4 s, each jittered to 50-100% (utils.retryWithBackoff).
 *
 * | Operation          | Class      | Why                                          |
 * |--------------------|------------|----------------------------------------------|
 * | getCollections     | REPEATABLE | read                                         |
 * | getCollection      | REPEATABLE | read                                         |
 * | collectionExists   | REPEATABLE | read                                         |
 * | getSchema          | REPEATABLE | read (also the vector-config read before upsert) |
 * | analyzeSchema      | REPEATABLE | read                                         |
 * | search             | REPEATABLE | read (POST)                                  |
 * | retrieve           | REPEATABLE | read (POST)                                  |
 * | scroll             | REPEATABLE | read (POST)                                  |
 * | count              | REPEATABLE | read (POST)                                  |
 * | getUsageStats      | REPEATABLE | read                                         |
 * | upsert             | REPEATABLE | write keyed by point id                      |
 * | setPayload         | REPEATABLE | write keyed by point id                      |
 * | overwritePayload   | REPEATABLE | write keyed by point id                      |
 * | deletePayload      | REPEATABLE | removing the same keys again changes nothing |
 * | createFieldIndex   | REPEATABLE | creating the same index again changes nothing |
 * | setSchema          | REPEATABLE | BECAUSE it is sent without If-Match (below) |
 * | createCollection   | ONCE       | a repeat finds the collection it just made   |
 * | deleteCollection   | ONCE       | a repeat finds nothing to delete             |
 * | delete             | ONCE       | deleting points; a repeat reports a false error |
 * | deleteSchema       | ONCE       | a repeat finds no schema                     |
 * | deleteFieldIndex   | ONCE       | a repeat finds no index                      |
 */

import {
  AetherfyVectorsError,
  NetworkError,
  RateLimitExceededError,
  RequestTimeoutError,
  ServiceUnavailableError,
} from './exceptions';

export const REPEATABLE = 'repeatable';
export const ONCE = 'once';
export type RetryClass = typeof REPEATABLE | typeof ONCE;

export const OPERATIONS = {
  getCollections: REPEATABLE,
  getCollection: REPEATABLE,
  collectionExists: REPEATABLE,
  getSchema: REPEATABLE,
  analyzeSchema: REPEATABLE,
  search: REPEATABLE,
  retrieve: REPEATABLE,
  scroll: REPEATABLE,
  count: REPEATABLE,
  getUsageStats: REPEATABLE,
  upsert: REPEATABLE,
  setPayload: REPEATABLE,
  overwritePayload: REPEATABLE,
  deletePayload: REPEATABLE,
  createFieldIndex: REPEATABLE,
  // Repeatable BECAUSE setSchema is sent without If-Match: a repeat writes the
  // same schema again. If it ever sends If-Match, a repeat after a hidden
  // success gets a false 412, and it must move to ONCE
  // (tests/unit/retry-policy.test.ts holds the two together).
  setSchema: REPEATABLE,
  createCollection: ONCE,
  deleteCollection: ONCE,
  delete: ONCE,
  deleteSchema: ONCE,
  deleteFieldIndex: ONCE,
} as const satisfies Record<string, RetryClass>;

export type Operation = keyof typeof OPERATIONS;

/**
 * The "wrong class" guard (tests/unit/retry-policy.test.ts): an operation
 * that sends DELETE, or whose name starts with delete/create, is ONCE unless
 * listed here, with the reason its repeat gives the same result.
 */
export const REPEATABLE_DESPITE_ITS_NAME: Readonly<
  Partial<Record<Operation, string>>
> = {
  deletePayload:
    'removes keys from points; removing them again changes nothing',
  createFieldIndex:
    're-creating an existing index with the same schema returns at once',
};

/** 503s the server answers at its edge, before running anything. */
export const REFUSED_BEFORE_ANYTHING_CODES: ReadonlySet<string> = new Set([
  'WORKSPACE_LOOKUP_UNAVAILABLE',
  'COLLECTION_LOOKUP_UNAVAILABLE',
  'PLACEMENT_UNAVAILABLE',
]);

/** Node error codes of a connection that was never made. */
const NEVER_CONNECTED_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
]);

interface FailureShape {
  status?: number;
  responseData?: Record<string, unknown>;
  code?: unknown;
  syscall?: unknown;
  message?: unknown;
  requestSent?: unknown;
}

function shapeOf(error: unknown): FailureShape {
  return error && typeof error === 'object' ? (error as FailureShape) : {};
}

/** The server's error code of an HTTP failure from HttpClient. */
function serverCode(e: FailureShape): string | undefined {
  const nested = e.responseData?.error;
  return nested && typeof nested === 'object'
    ? ((nested as { code?: unknown }).code as string | undefined)
    : undefined;
}

/** A transport failure (no HTTP status): HttpClient's "Network error: …". */
function isTransport(e: FailureShape): boolean {
  return (
    e.status === undefined &&
    typeof e.message === 'string' &&
    e.message.startsWith('Network error')
  );
}

/**
 * Kind 1: nothing ran, so any operation may be repeated. Reads both shapes:
 * HttpClient's raw error (the client's own retries), and the typed error a
 * client method throws (retryWithBackoff around a client call). A typed
 * transport error no longer carries Node's code, so it reads as ambiguous.
 */
export function refusedBeforeAnything(error: unknown): boolean {
  if (error instanceof ServiceUnavailableError) {
    return REFUSED_BEFORE_ANYTHING_CODES.has(error.code ?? '');
  }
  if (error instanceof RateLimitExceededError) {
    return error.retryAfter !== undefined;
  }
  if (error instanceof AetherfyVectorsError) return false;
  const e = shapeOf(error);
  if (e.status === 503) {
    return REFUSED_BEFORE_ANYTHING_CODES.has(serverCode(e) ?? '');
  }
  if (e.status === 429) {
    const retryAfter = e.responseData?.retryAfter;
    return retryAfter !== undefined && retryAfter !== null;
  }
  if (isTransport(e)) {
    if (e.requestSent === false) return true; // HttpClient saw no connect
    return (
      typeof e.code === 'string' &&
      (NEVER_CONNECTED_CODES.has(e.code) ||
        (e.code === 'ETIMEDOUT' && e.syscall === 'connect'))
    );
  }
  return false;
}

/** Kind 2: the request may have run (a timeout, a reset, another 5xx). */
export function ambiguous(error: unknown): boolean {
  if (refusedBeforeAnything(error)) return false;
  if (
    error instanceof ServiceUnavailableError ||
    error instanceof NetworkError ||
    error instanceof RequestTimeoutError
  ) {
    return true;
  }
  if (error instanceof AetherfyVectorsError) {
    return (error.statusCode ?? 0) >= 500;
  }
  const e = shapeOf(error);
  if (typeof e.status === 'number') return e.status >= 500;
  return isTransport(e);
}

/** The rule, for an operation of `retryClass`. */
export function shouldRetryClass(
  retryClass: RetryClass,
  error: unknown
): boolean {
  if (refusedBeforeAnything(error)) return true;
  return retryClass === REPEATABLE && ambiguous(error);
}

/** The rule, for one of the client's operations. */
export function shouldRetry(operation: Operation, error: unknown): boolean {
  return shouldRetryClass(OPERATIONS[operation], error);
}
