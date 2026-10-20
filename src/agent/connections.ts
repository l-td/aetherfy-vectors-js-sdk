/**
 * Connections: a fresh OAuth access token for a connected provider (Google, Slack,
 * Notion, Microsoft 365, HubSpot, Atlassian), by the connection's id.
 *
 * The platform runs the OAuth sign-in on the dashboard and keeps the grant;
 * this agent never sees a client secret or a refresh token. It asks the
 * control plane for an access token when it needs one:
 *
 *     GET  {AETHERFY_API_URL}/connections/usable          the ids this agent may use
 *     POST {AETHERFY_API_URL}/connections/{id}/token      {"min_valid_seconds": N}
 *     Authorization: Bearer {AETHERFY_API_KEY}
 *
 * and gets one valid for at least N seconds (never less than a minute),
 * refreshed first when it had to be. The Python helper's
 * `aetherfy_agent.connection` is the same contract with the same semantics.
 *
 * ONLY THIS MACHINE'S OWN KEY WORKS: the route answers the deployment-bound
 * `AETHERFY_API_KEY` the platform injects, and refuses an account key
 * ({@link ConnectionAccessDenied}).
 *
 * A PER-ID IN-PROCESS CACHE. A token is reused until it would have less than
 * `max(minValidSeconds, 60)` seconds left — the control plane's own margin —
 * so a loop calling `connection(google.id)` per item costs one request per
 * token lifetime. A token with no expiry (Notion's) is asked for again after
 * NO_EXPIRY_RECHECK_MS, so a disconnect or a reconnect on the dashboard reaches
 * a long-running agent.
 */

import {
  AgentError,
  CONNECTION_GRANT_NOT_ENABLED,
  CONNECTION_NEEDS_REAUTH,
  CONNECTION_NOT_FOUND,
  CONNECTION_PROVIDER_UNAVAILABLE,
  CONNECTION_REQUIRES_AGENT_KEY,
  ConnectionAccessDenied,
  ConnectionGrantNotEnabled,
  ConnectionNeedsReauth,
  ConnectionNotFound,
  ConnectionTokenError,
  ConnectionUnavailable,
} from './errors';
import { requestJson } from './http';
import { ConnectionInfo, ConnectionToken } from './models';
import { requireEnv, userAgent } from './runtime';
import { assertAllowedOptionKeys, optionKeys } from '../utils/options';

/** The bound the control plane enforces on `min_valid_seconds`. */
export const MIN_VALID_SECONDS_MAX = 3000;
export const MIN_VALID_SECONDS_DEFAULT = 300;

/** The control plane never hands out less; the cache holds to the same floor. */
const REFRESH_FLOOR_SECONDS = 60;

/**
 * How long a token with no expiry is reused before the control plane is asked
 * again. Without a bound it would outlive its own revocation.
 */
const NO_EXPIRY_RECHECK_MS = 5 * 60 * 1000;

export interface ConnectionOptions {
  /** 0 to 3000, default 300. The token stays valid at least this long. */
  minValidSeconds?: number;
}

// Derived from the type by optionKeys(): see src/utils/options.ts.
const CONNECTION_OPTION_KEYS = optionKeys<ConnectionOptions>({
  minValidSeconds: true,
});

const cache = new Map<string, { token: ConnectionToken; fetchedAt: number }>();

/** Empties the per-process cache. For tests. */
export function clearConnectionCache(): void {
  cache.clear();
}

function freshEnough(
  { token, fetchedAt }: { token: ConnectionToken; fetchedAt: number },
  minValidSeconds: number
): boolean {
  if (token.expires_at === null) {
    return Date.now() - fetchedAt < NO_EXPIRY_RECHECK_MS;
  }
  const marginMs = Math.max(minValidSeconds, REFRESH_FLOOR_SECONDS) * 1000;
  return token.expires_at.getTime() - Date.now() > marginMs;
}

function detailOf(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const detail = (body as Record<string, unknown>).detail;
  return detail && typeof detail === 'object'
    ? (detail as Record<string, unknown>)
    : {};
}

/**
 * Turns a refusal into the class its status and code select. An unrecognised
 * pairing arrives as ConnectionTokenError reporting exactly what came back.
 */
function refusal(
  status: number,
  body: unknown,
  fallback: string
): ConnectionTokenError {
  const detail = detailOf(body);
  const message =
    typeof detail.message === 'string' ? detail.message : fallback;
  const code = typeof detail.code === 'string' ? detail.code : undefined;
  if (status === 404 && code === CONNECTION_NOT_FOUND) {
    return new ConnectionNotFound(message, detail);
  }
  if (status === 403 && code === CONNECTION_GRANT_NOT_ENABLED) {
    return new ConnectionGrantNotEnabled(message, detail);
  }
  if (status === 409 && code === CONNECTION_NEEDS_REAUTH) {
    return new ConnectionNeedsReauth(message, detail);
  }
  if (status === 502 && code === CONNECTION_PROVIDER_UNAVAILABLE) {
    return new ConnectionUnavailable(message, detail);
  }
  if (status === 403 && code === CONNECTION_REQUIRES_AGENT_KEY) {
    return new ConnectionAccessDenied(message, detail);
  }
  return new ConnectionTokenError(message, { status, code, detail });
}

/**
 * The connections this agent's key may ask a token for: its own, its
 * workspace's, and those of a granted workspace whose grant has the connections
 * switch on. Each has an `id` to give {@link connection}.
 *
 * @throws {NotRunningOnAgent} `AETHERFY_API_URL` or `AETHERFY_API_KEY` is unset.
 * @throws {ConnectionAccessDenied} The key is not this agent's own.
 * @throws {ConnectionTokenError} Any other refusal — read `code`.
 * @throws {AgentTransportError} The request never reached the control plane.
 */
export async function listConnections(): Promise<ConnectionInfo[]> {
  const apiUrl = requireEnv(
    'AETHERFY_API_URL',
    'the Aetherfy API the connections come from'
  );
  const apiKey = requireEnv(
    'AETHERFY_API_KEY',
    'the key the connections are listed for'
  );
  const { status, body } = await requestJson(
    'GET',
    `${apiUrl.replace(/\/+$/, '')}/connections/usable`,
    { apiKey, userAgent: userAgent() }
  );
  if (status === 200 && Array.isArray(body)) {
    return (body as Record<string, unknown>[])
      .filter(item => item && typeof item.id === 'string')
      .map(item => ({
        id: String(item.id),
        name: String(item.name),
        provider: String(item.provider),
        scope: String(item.scope),
        account_label:
          typeof item.account_label === 'string' ? item.account_label : null,
        status: String(item.status),
        scopes: Array.isArray(item.scopes) ? item.scopes.map(String) : [],
      }));
  }
  throw refusal(
    status,
    body,
    `The connection list was refused with status ${status}.`
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A fresh access token for the connection `connectionId` (an id from
 * {@link listConnections}).
 *
 * The agent may use its own connections, its workspace's, and those of a
 * workspace it is granted whose grant has the connections switch on.
 *
 * @throws {TypeError} An unknown option.
 * @throws {AgentError} `connectionId` is not a connection id, or
 *   `minValidSeconds` is out of range.
 * @throws {NotRunningOnAgent} `AETHERFY_API_URL` or `AETHERFY_API_KEY` is unset.
 * @throws {ConnectionNotFound} `404 CONNECTION_NOT_FOUND`: no such connection, or
 *   not one this agent may use (the control plane does not say which).
 * @throws {ConnectionGrantNotEnabled} `403 CONNECTION_GRANT_NOT_ENABLED`: the
 *   connection is in a granted workspace whose grant does not cover connections.
 * @throws {ConnectionNeedsReauth} The provider refused the grant; reconnect it.
 * @throws {ConnectionUnavailable} The provider did not answer; retry shortly.
 * @throws {ConnectionAccessDenied} The key is not this agent's own.
 * @throws {ConnectionTokenError} Any other refusal — read `code`.
 * @throws {AgentTransportError} The request never reached the control plane.
 */
export async function connection(
  connectionId: string,
  options: ConnectionOptions = {}
): Promise<ConnectionToken> {
  assertAllowedOptionKeys(options, CONNECTION_OPTION_KEYS, 'connection');
  const minValidSeconds = options.minValidSeconds ?? MIN_VALID_SECONDS_DEFAULT;
  if (
    !Number.isInteger(minValidSeconds) ||
    minValidSeconds < 0 ||
    minValidSeconds > MIN_VALID_SECONDS_MAX
  ) {
    // AgentError, as wait() throws for its own out-of-range argument.
    throw new AgentError(
      `connection: minValidSeconds must be an integer from 0 to ${MIN_VALID_SECONDS_MAX}, got ${String(minValidSeconds)}.`
    );
  }
  if (typeof connectionId !== 'string' || !UUID.test(connectionId)) {
    throw new AgentError(
      `connection: connectionId must be a connection id (see listConnections()), got ${JSON.stringify(connectionId)}.`
    );
  }
  const id = connectionId.toLowerCase();

  const cached = cache.get(id);
  if (cached && freshEnough(cached, minValidSeconds)) return cached.token;

  const apiUrl = requireEnv(
    'AETHERFY_API_URL',
    'the Aetherfy API a connection token comes from'
  );
  const apiKey = requireEnv(
    'AETHERFY_API_KEY',
    'the key a connection token is issued to'
  );
  const { status, body } = await requestJson(
    'POST',
    `${apiUrl.replace(/\/+$/, '')}/connections/${id}/token`,
    {
      apiKey,
      userAgent: userAgent(),
      body: { min_valid_seconds: minValidSeconds },
    }
  );

  const answer = (body ?? {}) as Record<string, unknown>;
  if (status === 200 && typeof answer.access_token === 'string') {
    const token: ConnectionToken = {
      id: typeof answer.id === 'string' ? answer.id : id,
      access_token: answer.access_token,
      token_type:
        typeof answer.token_type === 'string' ? answer.token_type : 'Bearer',
      expires_at:
        typeof answer.expires_at === 'string'
          ? new Date(answer.expires_at)
          : null,
      provider: String(answer.provider),
      name: typeof answer.name === 'string' ? answer.name : '',
      account_label:
        typeof answer.account_label === 'string' ? answer.account_label : null,
      scopes: Array.isArray(answer.scopes) ? answer.scopes.map(String) : [],
    };
    cache.set(id, { token, fetchedAt: Date.now() });
    return token;
  }

  const error = refusal(
    status,
    body,
    `The token for connection '${id}' was refused with status ${status}.`
  );
  if (
    error instanceof ConnectionNeedsReauth ||
    error instanceof ConnectionNotFound
  ) {
    cache.delete(id);
  }
  throw error;
}
