/**
 * Connections: a fresh OAuth access token for Google, Slack or Notion, by name.
 *
 * The platform runs the OAuth sign-in on the dashboard and keeps the grant;
 * this agent never sees a client secret or a refresh token. It asks the
 * control plane for an access token when it needs one:
 *
 *     POST {AETHERFY_API_URL}/connections/{name}/token   {"min_valid_seconds": N}
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
 * A PER-NAME IN-PROCESS CACHE. A token is reused until it would have less than
 * `max(minValidSeconds, 60)` seconds left — the control plane's own margin —
 * so a loop calling `connection('google')` per item costs one request per
 * token lifetime. A token with no expiry (Notion's) is asked for again after
 * NO_EXPIRY_RECHECK_MS, so a disconnect or a reconnect on the dashboard reaches
 * a long-running agent.
 */

import {
  AgentError,
  CONNECTION_NEEDS_REAUTH,
  CONNECTION_NOT_FOUND,
  CONNECTION_PROVIDER_UNAVAILABLE,
  CONNECTION_REQUIRES_AGENT_KEY,
  ConnectionAccessDenied,
  ConnectionNeedsReauth,
  ConnectionNotFound,
  ConnectionTokenError,
  ConnectionUnavailable,
} from './errors';
import { requestJson } from './http';
import { ConnectionToken } from './models';
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
 * A fresh access token for the connection `name`.
 *
 * The agent sees its own connections and its workspace's; on a name clash its
 * own wins.
 *
 * @throws {TypeError} An unknown option.
 * @throws {AgentError} `minValidSeconds` is out of range.
 * @throws {NotRunningOnAgent} `AETHERFY_API_URL` or `AETHERFY_API_KEY` is unset.
 * @throws {ConnectionNotFound} No connection by that name here.
 * @throws {ConnectionNeedsReauth} The provider refused the grant; reconnect it.
 * @throws {ConnectionUnavailable} The provider did not answer; retry shortly.
 * @throws {ConnectionAccessDenied} The key is not this agent's own.
 * @throws {ConnectionTokenError} Any other refusal — read `code`.
 * @throws {AgentTransportError} The request never reached the control plane.
 */
export async function connection(
  name: string,
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

  const cached = cache.get(name);
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
    `${apiUrl.replace(/\/+$/, '')}/connections/${encodeURIComponent(name)}/token`,
    {
      apiKey,
      userAgent: userAgent(),
      body: { min_valid_seconds: minValidSeconds },
    }
  );

  const answer = (body ?? {}) as Record<string, unknown>;
  if (status === 200 && typeof answer.access_token === 'string') {
    const token: ConnectionToken = {
      access_token: answer.access_token,
      token_type:
        typeof answer.token_type === 'string' ? answer.token_type : 'Bearer',
      expires_at:
        typeof answer.expires_at === 'string'
          ? new Date(answer.expires_at)
          : null,
      provider: String(answer.provider),
      name: typeof answer.name === 'string' ? answer.name : name,
      account_label:
        typeof answer.account_label === 'string' ? answer.account_label : null,
      scopes: Array.isArray(answer.scopes) ? answer.scopes.map(String) : [],
    };
    cache.set(name, { token, fetchedAt: Date.now() });
    return token;
  }

  const detail = detailOf(body);
  const message =
    typeof detail.message === 'string'
      ? detail.message
      : `The token for connection '${name}' was refused with status ${status}.`;
  const code = typeof detail.code === 'string' ? detail.code : undefined;

  // The status AND the code select a class; an unrecognised pairing arrives as
  // ConnectionTokenError reporting exactly what came back.
  if (status === 404 && code === CONNECTION_NOT_FOUND) {
    throw new ConnectionNotFound(message, detail);
  }
  if (status === 409 && code === CONNECTION_NEEDS_REAUTH) {
    cache.delete(name);
    throw new ConnectionNeedsReauth(message, detail);
  }
  if (status === 502 && code === CONNECTION_PROVIDER_UNAVAILABLE) {
    throw new ConnectionUnavailable(message, detail);
  }
  if (status === 403 && code === CONNECTION_REQUIRES_AGENT_KEY) {
    throw new ConnectionAccessDenied(message, detail);
  }
  throw new ConnectionTokenError(message, { status, code, detail });
}
