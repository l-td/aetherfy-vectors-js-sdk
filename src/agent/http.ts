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

import { AgentTransportError } from './errors';

/** Version-stamped so a platform-side log can tell which helper release ran. */
export const USER_AGENT_PREFIX = 'aetherfy-agent-js/';

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface JsonResponse {
  status: number;
  /** Parsed JSON, or null when the body was empty or not JSON at all. */
  body: unknown;
}

export interface RequestOptions {
  apiKey: string;
  userAgent: string;
  body?: unknown;
  timeoutMs?: number;
  /** One retry for a connection-level failure. Never for a status. */
  retryConnectionErrors?: boolean;
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
 * ONE retry, and only for a connection-level failure — a DNS blip or a reset
 * socket on the way out, where nothing was recorded and repeating is safe. An
 * HTTP status is never retried here: a 4xx repeated is a 4xx, and retrying a
 * spawn the control plane may already have recorded would create a second run.
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

  const attempts = options.retryConnectionErrors === false ? 1 : 2;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      // ONLY the fetch call is inside the retry. fetch rejects when the
      // request never completed — a status, even a 500, resolves — so
      // everything caught here really is transport.
      //
      // READING THE BODY IS DELIBERATELY OUTSIDE IT. A body that fails
      // mid-stream arrives AFTER the server answered, and on a spawn the
      // control plane has already recorded the run: retrying there would
      // create a second one. readJson swallows that failure into a null body
      // and the status stands.
      lastError = error;
      continue;
    }
    return { status: response.status, body: await readJson(response) };
  }

  const reason =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new AgentTransportError(
    `${method} ${url} did not reach the Aetherfy control plane after ` +
      `${attempts} attempt(s): ${reason}`
  );
}
