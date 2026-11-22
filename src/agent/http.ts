/**
 * The helper's HTTP layer: the runtime's own `fetch`, nothing else.
 *
 * WHY NOT this SDK's axios client. Nothing here needs a session, an
 * interceptor, a retry policy or a base URL — two requests, both one-shot —
 * and `fetch` is built into every runtime the platform offers (node20, node22,
 * bun). Adding no dependency is a requirement of this module, not a
 * preference.
 *
 * EVERY REQUEST SETS AN EXPLICIT User-Agent, because the default one gets a
 * 403 from the edge's bot protection that reads exactly like an auth failure.
 * The docs make the same point in the hand-rolled examples; the helper is
 * where it stops being the customer's problem.
 */

import { parseRetryAfter } from '../retry-policy';
import { AgentTransportError } from './errors';
import type { PeerResponse } from './models';

/** Version-stamped so a platform-side log can tell which helper release ran. */
export const USER_AGENT_PREFIX = 'aetherfy-agent-js/';

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The control plane's 503s worth one more try after their `Retry-After`.
 * `RESOURCE_BUSY`: the request was refused before anything ran (its first
 * unit found no database slot), so ANY request may be sent again, a create or
 * a delete included. `REQUEST_TIMED_OUT` and `SERVICE_UNAVAILABLE` can come
 * PARTWAY through a request (a later unit timed out, or the archive storage an
 * upload or a rebuild needs was unreachable), so only a call whose repeat
 * gives the same result (`repeatable`) is sent again.
 */
export const RESOURCE_BUSY = 'RESOURCE_BUSY';
export const REQUEST_TIMED_OUT = 'REQUEST_TIMED_OUT';
export const SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE';
/** The 503s that may have partly run: repeated only for a repeatable call. */
const PARTWAY: readonly string[] = [REQUEST_TIMED_OUT, SERVICE_UNAVAILABLE];
/** The longest `Retry-After` the helper waits out itself: the request's own timeout. */
export const MAX_RETRY_AFTER_WAITED_SECONDS = DEFAULT_TIMEOUT_MS / 1000;

/**
 * How a `Retry-After` is waited out: an object of its own so a test records
 * the wait instead of taking it.
 */
export const waiting = {
  sleep: (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms)),
};

function worthOneMoreTry(
  status: number,
  body: unknown,
  retryAfter: number | undefined,
  options: RequestOptions
): boolean {
  const refusals = options.refusals ?? 'by-the-rule';
  const detail = (body as { detail?: unknown } | null)?.detail;
  const code = (detail as { code?: unknown } | null | undefined)?.code;
  const retryable =
    refusals !== 'none' &&
    typeof code === 'string' &&
    (code === RESOURCE_BUSY ||
      (refusals === 'by-the-rule' &&
        options.repeatable &&
        PARTWAY.includes(code)));
  return (
    status === 503 &&
    retryable &&
    retryAfter !== undefined &&
    retryAfter >= 0 &&
    retryAfter <= MAX_RETRY_AFTER_WAITED_SECONDS
  );
}

export interface JsonResponse {
  status: number;
  /** Parsed JSON, or null when the body was empty or not JSON at all. */
  body: unknown;
  /**
   * The seconds the response's `Retry-After` header asked to wait (a number or
   * an HTTP date), or undefined when it sent none or an unreadable one. Nothing
   * here waits it: a request repeated before that time is refused again, and
   * deciding whether to repeat is the caller's.
   */
  retryAfter?: number;
}

export interface RequestOptions {
  apiKey: string;
  userAgent: string;
  body?: unknown;
  /**
   * Undefined: the default timeout. `null`: none at all, for the one call that
   * blocks until it is released (a waiting receive's local call to its
   * supervisor, whose deadline, when there is one, is the control plane's).
   */
  timeoutMs?: number | null;
  /**
   * Whether a repeat of this call gives the same result: a read, a cancel, or
   * a spawn or message that carries its own id (the control plane stores it
   * once). Decides the retry of a request that MAY HAVE BEEN DELIVERED (a
   * timeout or a reset after it was sent). REQUIRED: every caller decides it in
   * the open, so a new call never inherits a retry it did not think about.
   */
  repeatable: boolean;
  /**
   * Which of the control plane's 503s are waited out and repeated (see
   * {@link requestJson}). `'by-the-rule'`, the default: `RESOURCE_BUSY` for any
   * call, `REQUEST_TIMED_OUT` and `SERVICE_UNAVAILABLE` for a repeatable one.
   * `'resource-busy-only'`: `RESOURCE_BUSY` alone. `'none'`: none, returned as
   * they came. The peer lookup chooses: it has a last known address to serve
   * at once instead.
   */
  refusals?: 'by-the-rule' | 'resource-busy-only' | 'none';
}

/**
 * Never throws. A body that cannot be read or parsed is reported as `null`
 * and the STATUS carries the meaning — an edge error page is not JSON, and a
 * truncated stream is not a reason to lose a status the server did send.
 */
async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Send one JSON request and return its status and parsed body.
 *
 * An HTTP error status is a RETURN, not a throw: the caller maps 413 and 429
 * onto its own types and needs the body to do it. Only a request that never
 * got an answer throws, as `AgentTransportError`.
 *
 * AT MOST ONE RETRY, and only where a repeat cannot do the work twice:
 *
 * - a request that NEVER LEFT ({@link neverDelivered}: the name did not
 *   resolve, the connection was refused) is retried, whatever the call;
 * - a request that may have been DELIVERED (a timeout or a reset after it was
 *   sent) is retried only when `options.repeatable` says its repeat gives the
 *   same result. A call that is not repeatable throws at once, saying the
 *   request may have been applied, because a blind repeat could do the work a
 *   second time;
 * - a 503 with a `Retry-After` is retried after it: `RESOURCE_BUSY` whatever
 *   the call (it was refused before anything ran), `REQUEST_TIMED_OUT` and
 *   `SERVICE_UNAVAILABLE` only when the call is `repeatable` (either can come
 *   partway through a request). It waits at most
 *   {@link MAX_RETRY_AFTER_WAITED_SECONDS}; a longer one is returned as it
 *   came.
 *
 * No other HTTP status is retried here: a 4xx repeated is a 4xx.
 */
export async function requestJson(
  method: string,
  url: string,
  options: RequestOptions
): Promise<JsonResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
    'User-Agent': options.userAgent,
    Accept: 'application/json',
  };
  let payload: string | undefined;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }

  let lastError: unknown = null;
  let attempts = 0;

  while (attempts < 2) {
    attempts += 1;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        signal:
          options.timeoutMs === null
            ? undefined
            : AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      // ONLY the fetch call is inside the retry. fetch rejects when the
      // request never completed — a status, even a 500, resolves — so
      // everything caught here really is transport.
      //
      // READING THE BODY IS DELIBERATELY OUTSIDE IT. A body that fails
      // mid-stream arrives AFTER the server answered, and the work is done.
      // readJson swallows that failure into a null body and the status stands.
      lastError = error;
      if (neverDelivered(error) || options.repeatable) {
        continue;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new AgentTransportError(
        `${method} ${url} got no answer and may have been applied: ${reason}`
      );
    }
    const answer: JsonResponse = {
      status: response.status,
      body: await readJson(response),
      retryAfter: parseRetryAfter(response.headers.get('retry-after')),
    };
    if (
      attempts < 2 &&
      worthOneMoreTry(answer.status, answer.body, answer.retryAfter, options)
    ) {
      await waiting.sleep((answer.retryAfter as number) * 1000);
      continue;
    }
    return answer;
  }

  const reason =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new AgentTransportError(
    `${method} ${url} did not reach the Aetherfy control plane after ` +
      `${attempts} attempt(s): ${reason}`
  );
}

/**
 * One request to a peer: either its `response`, or the `failure` that kept any
 * response from coming.
 *
 * `failure` is set only when the request PROVABLY NEVER REACHED A PEER: the name
 * did not resolve, or the connection was refused. That is the one outcome
 * `callAgent` answers by looking the peer up again, because repeating the
 * request cannot run it twice. A reset or a timeout is NOT that: either can
 * come after the peer acted, so {@link requestPeer} throws an
 * {@link AgentTransportError} for it, as it does for a body that fails
 * mid-stream. A VALUE, NOT AN ERROR, for the retryable case, so the helper's
 * error hierarchy stays what a caller can catch. The Python helper's
 * `PeerAttempt` has the same two fields.
 */
export interface PeerAttempt {
  response?: PeerResponse;
  failure?: string;
}

/** The `code`s of a connection that nothing accepted: the name, or the port. */
const NEVER_REACHED_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

/**
 * Whether a rejected `fetch` provably reached nobody: the name did not resolve,
 * or the connection was refused. Node's `fetch` rejects with a
 * `TypeError('fetch failed')` whose `cause` carries the socket error and its
 * `code`; a timeout or an abort has no such code and is not that, because it
 * can come after the far side received the request and acted on it. ONE answer
 * for every request this module sends: {@link requestJson} to the control plane
 * and {@link requestPeer} to a peer read it, and so does the vectors client's
 * retry policy (`src/retry-policy.ts`, "refused before anything happened").
 */
function neverDelivered(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' && NEVER_REACHED_CODES.has(cause.code);
}

export interface PeerRequestOptions {
  userAgent: string;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
}

/**
 * Send one request to a PEER and return whatever it answered.
 *
 * THE AETHERFY KEY IS NOT AN OPTION, and that is the point: a peer is another
 * service, and a bearer token for the whole account sent to it would hand the
 * account to whatever that service logs. The only headers are the explicit
 * `User-Agent` this module always sets and the caller's own.
 *
 * No retry here. Where a retry makes sense is the caller's to say: it needs the
 * peer looked up again first, and repeating the same address would only repeat
 * the failure.
 *
 * An HTTP status of any kind is a RETURN, a 3xx included: it is not followed
 * (`redirect: 'manual'`). `fetch` otherwise follows it, replaying the body of a
 * 307 or 308 to whatever host `Location` names, and a peer's redirect is the
 * peer's answer like any other status. Only a request that never reached a peer
 * (the name did not resolve, the connection was refused) comes back with a
 * `failure` and no `response`; a reset, a timeout, or a body that cannot be
 * read after the status arrived throws a plain {@link AgentTransportError}, and
 * is not retried, because the peer may have acted on the request.
 */
export async function requestPeer(
  method: string,
  url: string,
  options: PeerRequestOptions
): Promise<PeerAttempt> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'User-Agent': options.userAgent, ...options.headers },
      body: options.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    // fetch rejects only when the request never completed: a status, even a
    // 500, resolves. Of the ways it can, only two are known to have reached
    // nobody; the rest (a reset, a timeout) may have come after the peer acted.
    const reason = error instanceof Error ? error.message : String(error);
    if (neverDelivered(error)) {
      return { failure: reason };
    }
    throw new AgentTransportError(
      `${method} ${url} got no answer and may or may not have run: ${reason}`
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AgentTransportError(
      `${method} ${url} answered ${response.status} but its body could not ` +
        `be read: ${reason}`
    );
  }
  // Headers yields lower-case names by specification, which is what the
  // response object promises.
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    response: {
      status: response.status,
      headers,
      text,
      json: () => JSON.parse(text) as unknown,
    },
  };
}
